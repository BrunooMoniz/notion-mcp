// src/rag/graph-storage.ts
// F5 — Brain graph data layer (v2).
// Modes:
//   overview (default): top N entities by mention count, entity-entity edges only, no docs.
//   focus (entity_ids set): selected entities + first-degree neighbors,
//         optionally with documents (include_docs=true).
// All values parameterised; account isolation guaranteed by WHERE account_id = $1.
import { getPool } from "./storage.js";

export interface GraphNode {
  id: string;          // "e:<entity_id>" or "d:<source_id>"
  kind: "entity" | "doc";
  label: string;
  type: string;        // entity type (pessoa/empresa/projeto) or source_type
  weight: number;      // entity: mention_count; doc: doc_mention_count
  url?: string;        // doc nodes only
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

  // Caps
  const defaultCap = mode === "overview" ? 40 : 60;
  const maxNodes = Math.min(Math.max(opts.max_nodes ?? defaultCap, 1), 150);
  const includeDocs = mode === "focus" && (opts.include_docs === true);

  // --- 1. Entity nodes ---------------------------------------------------
  const eParams: unknown[] = [accountId, maxNodes];
  const eClauses: string[] = ["e.account_id = $1"];
  let eIdx = 3;

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
       AND em.chunk_id IN (SELECT id FROM brain_chunks WHERE account_id = $1)
     WHERE ${eWhere}
     GROUP BY e.id, e.type, e.name
     ORDER BY COUNT(em.id) DESC, e.name
     LIMIT $2`,
    eParams,
  );

  const cappedERows = eRows.slice(0, maxNodes);
  const entityNodes: GraphNode[] = cappedERows.map((r) => ({
    id: `e:${r.id}`,
    kind: "entity",
    label: r.name,
    type: r.type,
    weight: parseInt(r.mention_count, 10) || 0,
  }));

  const fetchedEntityIds = cappedERows.map((r) => r.id);

  // --- 2. Doc nodes (only in focus + include_docs) -----------------------
  let docNodes: GraphNode[] = [];

  if (includeDocs && fetchedEntityIds.length > 0) {
    const docLimit = Math.max(maxNodes - fetchedEntityIds.length, 5);
    const docParams: unknown[] = [accountId, fetchedEntityIds, docLimit];
    let docWhere = `bc.account_id = $1`;

    if (entityIds.length > 0) {
      // Only docs that mention at least one of the original selected entities
      docParams.push(entityIds);
      docWhere += ` AND bc.source_id IN (
        SELECT DISTINCT bc2.source_id
        FROM entity_mentions em2
        JOIN brain_chunks bc2 ON bc2.id = em2.chunk_id AND bc2.account_id = $1
        WHERE em2.entity_id = ANY($4::bigint[])
      )`;
    }

    const { rows: dRows } = await p.query<{
      source_id: string;
      source_type: string;
      title: string;
      parent_url: string | null;
      doc_mention_count: string;
    }>(
      `SELECT bc.source_id, bc.source_type, bc.parent_url,
              split_part(MIN(bc.text), E'\n', 1) AS title,
              COUNT(em.id)::text AS doc_mention_count
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
      const node: GraphNode = {
        id: `d:${r.source_id}`,
        kind: "doc",
        label,
        type: r.source_type,
        weight: parseInt(r.doc_mention_count, 10) || 0,
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
         AND bc.source_id = ANY($3::text[])
       GROUP BY em.entity_id, bc.source_id`,
      [accountId, fetchedEntityIds, docSourceIds],
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
         AND em2.entity_id = ANY($2::bigint[])
       GROUP BY em1.entity_id, em2.entity_id
       HAVING COUNT(DISTINCT bc.source_id) >= 2`,
      [accountId, fetchedEntityIds],
    );
    eeEdges = eeRows.map((r) => ({
      a: `e:${r.entity_a}`,
      b: `e:${r.entity_b}`,
      weight: parseInt(r.weight, 10) || 2,
    }));
  }

  return {
    nodes,
    edges: [...edEdges, ...eeEdges],
    mode,
  };
}
