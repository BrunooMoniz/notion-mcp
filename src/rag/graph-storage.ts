// src/rag/graph-storage.ts
// F5 — Brain graph data layer (v2).
// Modes:
//   overview (default): top N entities by mention count, entity-entity edges only, no docs.
//   focus (entity_ids set): selected entities + first-degree neighbors,
//         optionally with documents (include_docs=true).
// v2 extras (retrocompatíveis):
//   days: janela temporal — menções só contam quando a data do documento do chunk
//         (metadata->>'data' com cast seguro, fallback source_updated) está na janela.
//         Afeta seleção dos top nós, weight dos nós e weight das arestas. Chunks sem
//         data conhecida (NULL) ficam fora da janela; entidades sem menção na janela
//         saem do grafo (HAVING > 0).
//   min_edge_weight: mínimo de co-ocorrência por aresta (default 2, clamp 1..50).
//   group_by: "community" (union-find sobre as arestas computadas) ou "type".
//   last_seen: data do documento mais recente que menciona a entidade, SEMPRE sem o
//         filtro de days; nós doc usam a data do próprio doc.
//   recent: igual a weight — com days presente o weight já é a contagem na janela,
//         então recent é a contagem recente; sem days, recent == weight total.
// All values parameterised; account isolation guaranteed by WHERE account_id = $1.
import { getPool } from "./storage.js";

export interface GraphNode {
  id: string;          // "e:<entity_id>" or "d:<source_id>"
  kind: "entity" | "doc";
  label: string;
  type: string;        // entity type (pessoa/empresa/projeto) or source_type
  weight: number;      // entity: mention_count (na janela, se days); doc: doc_mention_count
  url?: string;        // doc nodes only
  last_seen: string | null;       // ISO date do doc mais recente (sem filtro de days)
  recent: number;                 // == weight (ver nota no topo do arquivo)
  group?: number | string | null; // presente só quando group_by=community|type
}

export interface GraphEdge {
  a: string;
  b: string;
  weight: number;
}

export interface BrainGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mode: "overview" | "focus";
}

export interface BuildGraphOpts {
  mode?: "overview" | "focus";
  type?: string;
  entity_ids?: number[];   // focus mode: entities to center on
  entity_id?: number;      // legacy compat → treated as entity_ids=[entity_id]
  // Legacy multi-entity subgraph field (pre-v2) - mapped to entity_ids
  entityIds?: number[];
  include_docs?: boolean;  // default false; only honoured in focus mode
  max_nodes?: number;      // overview default 40, focus default 60, max 150
  days?: number;           // janela temporal em dias (clamp 1..3650); ausente = sem janela
  group_by?: "community" | "type" | "none"; // default none (sem campo group)
  min_edge_weight?: number; // HAVING da co-ocorrência (default 2, clamp 1..50)
}

// Data do documento de um chunk, com cast seguro: metadata->>'data' pode ser
// data ou datetime ISO (regex valida o prefixo YYYY-MM-DD antes do ::date);
// qualquer outro valor (ou NULL) cai para source_updated::date.
const DOC_DATE_SQL =
  "CASE WHEN bc.metadata->>'data' ~ '^\\d{4}-\\d{2}-\\d{2}' " +
  "THEN substring(bc.metadata->>'data' from 1 for 10)::date " +
  "ELSE bc.source_updated::date END";

/** Componentes conectados via union-find em memória (puro, determinístico).
 *  Componentes ordenados por tamanho desc; empate desempatado pelo menor id de
 *  membro (ordem lexicográfica), groups 0,1,2... Nós sem nenhuma aresta → null.
 *  Arestas com endpoint fora de nodeIds são ignoradas. */
export function computeCommunityGroups(
  nodeIds: string[],
  edges: Array<{ a: string; b: string }>,
): Map<string, number | null> {
  const parent = new Map<string, string>();
  for (const id of nodeIds) if (!parent.has(id)) parent.set(id, id);

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x; // path compression
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  const linked = new Set<string>();
  for (const e of edges) {
    if (!parent.has(e.a) || !parent.has(e.b)) continue;
    linked.add(e.a);
    linked.add(e.b);
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const components = new Map<string, string[]>();
  for (const id of nodeIds) {
    if (!linked.has(id)) continue; // nó sem aresta → group null
    const root = find(id);
    const members = components.get(root);
    if (members) members.push(id);
    else components.set(root, [id]);
  }

  const ordered = [...components.values()].sort((x, y) => {
    if (y.length !== x.length) return y.length - x.length;
    const mx = x.reduce((m, v) => (v < m ? v : m), x[0]);
    const my = y.reduce((m, v) => (v < m ? v : m), y[0]);
    return mx < my ? -1 : mx > my ? 1 : 0;
  });

  const out = new Map<string, number | null>();
  for (const id of nodeIds) out.set(id, null);
  ordered.forEach((members, i) => {
    for (const id of members) out.set(id, i);
  });
  return out;
}

export async function buildBrainGraph(
  accountId: string,
  opts: BuildGraphOpts,
): Promise<BrainGraph> {
  const p = getPool();

  // Normalise legacy entity_id / entityIds
  const legacyId = opts.entity_id !== undefined ? opts.entity_id : undefined;
  const legacyIds = opts.entityIds && opts.entityIds.length > 0 ? opts.entityIds : undefined;
  const entityIds: number[] =
    opts.entity_ids && opts.entity_ids.length > 0
      ? opts.entity_ids
      : legacyIds !== undefined
        ? legacyIds
        : legacyId !== undefined
          ? [legacyId]
          : [];

  // Determine mode
  const isFocus = opts.mode === "focus" || entityIds.length > 0;
  const mode: "overview" | "focus" = isFocus ? "focus" : "overview";

  // Caps / clamps
  const defaultCap = mode === "overview" ? 40 : 60;
  const maxNodes = Math.min(Math.max(opts.max_nodes ?? defaultCap, 1), 150);
  const includeDocs = mode === "focus" && (opts.include_docs === true);
  const days =
    typeof opts.days === "number" && Number.isFinite(opts.days)
      ? Math.min(Math.max(Math.floor(opts.days), 1), 3650)
      : undefined;
  const minEdgeWeight =
    typeof opts.min_edge_weight === "number" && Number.isFinite(opts.min_edge_weight)
      ? Math.min(Math.max(Math.floor(opts.min_edge_weight), 1), 50)
      : 2;

  // --- 1. Entity nodes ---------------------------------------------------
  const eParams: unknown[] = [accountId, maxNodes];
  const eClauses: string[] = ["e.account_id = $1"];
  let eIdx = 3;

  // Janela temporal: menções só contam quando o doc do chunk está na janela.
  let mentionWindowFilter = "";
  if (days !== undefined) {
    mentionWindowFilter = ` AND ${DOC_DATE_SQL} >= (CURRENT_DATE - $${eIdx}::int)`;
    eParams.push(days);
    eIdx++;
  }

  if (opts.type) {
    eClauses.push(`e.type = $${eIdx++}`);
    eParams.push(opts.type);
  }

  if (mode === "focus" && entityIds.length > 0) {
    // Include the target entities + their first-degree entity neighbours
    eClauses.push(`(
      e.id = ANY($${eIdx}::bigint[])
      OR e.id IN (
        SELECT DISTINCT em2.entity_id
        FROM entity_mentions em1
        JOIN entity_mentions em2
          ON em2.chunk_id = em1.chunk_id
         AND em2.entity_id <> em1.entity_id
        WHERE em1.entity_id = ANY($${eIdx}::bigint[])
          AND em1.chunk_id IN (SELECT id FROM brain_chunks WHERE account_id = $1)
      )
    )`);
    eParams.push(entityIds);
    eIdx++;
  }

  const eWhere = eClauses.join(" AND ");
  // Com days, entidade sem menção na janela sai do grafo (HAVING > 0).
  const eHaving = days !== undefined ? "HAVING COUNT(em.id) > 0" : "";
  const { rows: eRows } = await p.query<{
    id: number;
    type: string;
    name: string;
    mention_count: string;
  }>(
    `SELECT e.id, e.type, e.name,
            COUNT(em.id)::text AS mention_count
     FROM entities e
     LEFT JOIN entity_mentions em ON em.entity_id = e.id
       AND em.chunk_id IN (SELECT bc.id FROM brain_chunks bc WHERE bc.account_id = $1${mentionWindowFilter})
     WHERE ${eWhere}
     GROUP BY e.id, e.type, e.name
     ${eHaving}
     ORDER BY COUNT(em.id) DESC, e.name
     LIMIT $2`,
    eParams,
  );

  const cappedERows = eRows.slice(0, maxNodes);
  const entityNodes: GraphNode[] = cappedERows.map((r) => {
    const weight = parseInt(r.mention_count, 10) || 0;
    return {
      id: `e:${r.id}`,
      kind: "entity" as const,
      label: r.name,
      type: r.type,
      weight,
      last_seen: null, // preenchido na query dedicada (sem filtro de days)
      recent: weight,
    };
  });

  const fetchedEntityIds = cappedERows.map((r) => r.id);

  // --- 2. Doc nodes (only in focus + include_docs) -----------------------
  let docNodes: GraphNode[] = [];

  if (includeDocs && fetchedEntityIds.length > 0) {
    const docLimit = Math.max(maxNodes - fetchedEntityIds.length, 5);
    const docParams: unknown[] = [accountId, fetchedEntityIds, docLimit];
    let dIdx = 4;
    const docClauses: string[] = ["bc.account_id = $1"];

    if (days !== undefined) {
      docClauses.push(`${DOC_DATE_SQL} >= (CURRENT_DATE - $${dIdx}::int)`);
      docParams.push(days);
      dIdx++;
    }

    if (entityIds.length > 0) {
      // Only docs that mention at least one of the original selected entities
      docParams.push(entityIds);
      docClauses.push(`bc.source_id IN (
        SELECT DISTINCT bc2.source_id
        FROM entity_mentions em2
        JOIN brain_chunks bc2 ON bc2.id = em2.chunk_id AND bc2.account_id = $1
        WHERE em2.entity_id = ANY($${dIdx}::bigint[])
      )`);
      dIdx++;
    }

    const docWhere = docClauses.join(" AND ");
    const { rows: dRows } = await p.query<{
      source_id: string;
      source_type: string;
      title: string;
      parent_url: string | null;
      doc_mention_count: string;
      last_seen: string | null;
    }>(
      `SELECT bc.source_id, bc.source_type, bc.parent_url,
              split_part(MIN(bc.text), E'\n', 1) AS title,
              COUNT(em.id)::text AS doc_mention_count,
              MAX(${DOC_DATE_SQL})::text AS last_seen
       FROM brain_chunks bc
       JOIN entity_mentions em ON em.chunk_id = bc.id
       WHERE ${docWhere}
         AND em.entity_id = ANY($2::bigint[])
       GROUP BY bc.source_id, bc.source_type, bc.parent_url
       ORDER BY COUNT(em.id) DESC
       LIMIT $3`,
      docParams,
    );

    docNodes = dRows.map((r) => {
      const raw = (r.title ?? "").trim();
      const label = raw.replace(/^\[[^\]]*\]\s*/, "").trim() || raw || "(sem título)";
      const weight = parseInt(r.doc_mention_count, 10) || 0;
      const node: GraphNode = {
        id: `d:${r.source_id}`,
        kind: "doc",
        label,
        type: r.source_type,
        weight,
        last_seen: r.last_seen ?? null, // data do próprio doc
        recent: weight,
      };
      if (r.parent_url) node.url = r.parent_url;
      return node;
    });
  }

  const nodes: GraphNode[] = [...entityNodes, ...docNodes];

  // --- 3. Entity-doc edges (focus + include_docs only) ------------------
  let edEdges: GraphEdge[] = [];

  if (includeDocs && fetchedEntityIds.length > 0 && docNodes.length > 0) {
    const docSourceIds = docNodes.map((d) => d.id.slice(2));
    const edParams: unknown[] = [accountId, fetchedEntityIds, docSourceIds];
    let edDateFilter = "";
    if (days !== undefined) {
      edParams.push(days);
      edDateFilter = ` AND ${DOC_DATE_SQL} >= (CURRENT_DATE - $4::int)`;
    }
    const { rows: edRows } = await p.query<{
      entity_id: number;
      source_id: string;
      weight: string;
    }>(
      `SELECT em.entity_id, bc.source_id,
              COUNT(em.id)::text AS weight
       FROM entity_mentions em
       JOIN brain_chunks bc ON bc.id = em.chunk_id AND bc.account_id = $1
       WHERE em.entity_id = ANY($2::bigint[])
         AND bc.source_id = ANY($3::text[])${edDateFilter}
       GROUP BY em.entity_id, bc.source_id`,
      edParams,
    );
    edEdges = edRows.map((r) => ({
      a: `e:${r.entity_id}`,
      b: `d:${r.source_id}`,
      weight: parseInt(r.weight, 10) || 1,
    }));
  }

  // --- 4. Entity-entity co-occurrence edges ----------------------------
  let eeEdges: GraphEdge[] = [];

  if (fetchedEntityIds.length > 1) {
    const eeParams: unknown[] = [accountId, fetchedEntityIds, minEdgeWeight];
    let eeDateFilter = "";
    if (days !== undefined) {
      eeParams.push(days);
      eeDateFilter = ` AND ${DOC_DATE_SQL} >= (CURRENT_DATE - $4::int)`;
    }
    const { rows: eeRows } = await p.query<{
      entity_a: number;
      entity_b: number;
      weight: string;
    }>(
      `SELECT em1.entity_id AS entity_a,
              em2.entity_id AS entity_b,
              COUNT(DISTINCT bc.source_id)::text AS weight
       FROM entity_mentions em1
       JOIN entity_mentions em2
         ON em2.chunk_id = em1.chunk_id
        AND em2.entity_id > em1.entity_id
       JOIN brain_chunks bc ON bc.id = em1.chunk_id AND bc.account_id = $1
       WHERE em1.entity_id = ANY($2::bigint[])
         AND em2.entity_id = ANY($2::bigint[])${eeDateFilter}
       GROUP BY em1.entity_id, em2.entity_id
       HAVING COUNT(DISTINCT bc.source_id) >= $3`,
      eeParams,
    );
    eeEdges = eeRows.map((r) => ({
      a: `e:${r.entity_a}`,
      b: `e:${r.entity_b}`,
      weight: parseInt(r.weight, 10) || minEdgeWeight,
    }));
  }

  const edges = [...edEdges, ...eeEdges];

  // --- 5. last_seen das entidades (SEM filtro de days, sempre) ----------
  if (fetchedEntityIds.length > 0) {
    const { rows: lsRows } = await p.query<{
      entity_id: number | string;
      last_seen: string | null;
    }>(
      `SELECT em.entity_id, MAX(${DOC_DATE_SQL})::text AS last_seen
       FROM entity_mentions em
       JOIN brain_chunks bc ON bc.id = em.chunk_id AND bc.account_id = $1
       WHERE em.entity_id = ANY($2::bigint[])
       GROUP BY em.entity_id`,
      [accountId, fetchedEntityIds],
    );
    const lastSeenById = new Map(lsRows.map((r) => [`e:${r.entity_id}`, r.last_seen ?? null]));
    for (const n of entityNodes) {
      const ls = lastSeenById.get(n.id);
      if (ls !== undefined) n.last_seen = ls;
    }
  }

  // --- 6. group_by (em memória, sobre o grafo já computado) -------------
  if (opts.group_by === "type") {
    for (const n of nodes) n.group = n.type;
  } else if (opts.group_by === "community") {
    const groups = computeCommunityGroups(nodes.map((n) => n.id), edges);
    for (const n of nodes) n.group = groups.get(n.id) ?? null;
  }

  return { nodes, edges, mode };
}
