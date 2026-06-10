// src/rag/graph-storage.ts
// F5 — Brain graph data layer.
// Computes nodes and edges for the entity-document co-occurrence graph.
// Two queries: (1) entity nodes + doc nodes; (2) entity-doc edges + entity-entity edges.
// All values parameterised; account isolation guaranteed by WHERE account_id = $1.
import { getPool } from "./storage.js";

export interface GraphNode {
  id: string;          // "e:<entity_id>" or "d:<source_id>"
  kind: "entity" | "doc";
  label: string;
  type: string;        // entity type (pessoa/empresa/projeto) or source_type (notion/granola/…)
  weight: number;      // entity: mention_count; doc: doc_mention_count
  url?: string;        // doc nodes only, when parent_url is set
}

export interface GraphEdge {
  a: string;
  b: string;
  weight: number;
}

export interface BrainGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface BuildGraphOpts {
  type?: string;       // filter entity nodes by type
  entity_id?: number;  // subgraph: only return this entity + its neighbours
  max_nodes?: number;  // cap, default 120, max 300
}

export async function buildBrainGraph(
  accountId: string,
  opts: BuildGraphOpts,
): Promise<BrainGraph> {
  const p = getPool();
  const maxNodes = Math.min(Math.max(opts.max_nodes ?? 120, 1), 300);

  // --- 1. Entity nodes -------------------------------------------------
  const eParams: unknown[] = [accountId, maxNodes];
  const eClauses: string[] = ["e.account_id = $1"];
  let eIdx = 3;

  if (opts.type) {
    eClauses.push(`e.type = $${eIdx++}`);
    eParams.push(opts.type);
  }
  if (opts.entity_id !== undefined) {
    // Subgraph: include the target entity + its first-degree entity neighbours
    // (entities that share at least one document with the target).
    eClauses.push(`(
      e.id = $${eIdx}
      OR e.id IN (
        SELECT DISTINCT em2.entity_id
        FROM entity_mentions em1
        JOIN entity_mentions em2 ON em2.chunk_id = em1.chunk_id AND em2.entity_id <> em1.entity_id
        WHERE em1.entity_id = $${eIdx}
          AND em1.chunk_id IN (SELECT id FROM brain_chunks WHERE account_id = $1)
      )
    )`);
    eParams.push(opts.entity_id);
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

  // Enforce JS-side cap in addition to SQL LIMIT (fake-pool tests don't honour LIMIT).
  const cappedERows = eRows.slice(0, maxNodes);
  const entityNodes: GraphNode[] = cappedERows.map((r) => ({
    id: `e:${r.id}`,
    kind: "entity",
    label: r.name,
    type: r.type,
    weight: parseInt(r.mention_count, 10) || 0,
  }));

  const entityIds = cappedERows.map((r) => r.id);

  // --- 2. Doc nodes (top-N connected documents) -------------------------
  // Only documents that have at least one mention of a selected entity.
  let docNodes: GraphNode[] = [];

  if (entityIds.length > 0) {
    const docLimit = Math.max(maxNodes - entityIds.length, 10);
    let docWhere = `bc.account_id = $1`;
    const docParams: unknown[] = [accountId, entityIds, docLimit];

    if (opts.entity_id !== undefined) {
      // Subgraph: only docs that mention the target entity.
      docParams.push(opts.entity_id);
      docWhere += ` AND bc.source_id IN (
        SELECT DISTINCT bc2.source_id
        FROM entity_mentions em2
        JOIN brain_chunks bc2 ON bc2.id = em2.chunk_id AND bc2.account_id = $1
        WHERE em2.entity_id = $4
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
      // Strip provenance header from first line to get a clean title
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

  // --- 3. Entity-doc edges ---------------------------------------------
  let edEdges: GraphEdge[] = [];

  if (entityIds.length > 0 && docNodes.length > 0) {
    const docSourceIds = docNodes.map((d) => d.id.slice(2)); // strip "d:"
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
      [accountId, entityIds, docSourceIds],
    );
    edEdges = edRows.map((r) => ({
      a: `e:${r.entity_id}`,
      b: `d:${r.source_id}`,
      weight: parseInt(r.weight, 10) || 1,
    }));
  }

  // --- 4. Entity-entity co-occurrence edges ----------------------------
  let eeEdges: GraphEdge[] = [];

  if (entityIds.length > 1) {
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
      [accountId, entityIds],
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
  };
}
