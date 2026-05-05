// src/classifier/types.ts
// Types for the auto-classifier (Fase 3A + 3B).

export type Frente = "Global Cripto" | "Nora Finance" | "Pessoal" | "Conteudo";
export type ReuniaoTipo =
  | "1:1"
  | "Time interno"
  | "Cliente"
  | "Parceiro"
  | "Juridico"
  | "Investidor"
  | "Pessoal"
  | "Outro";
export type InsightCategoria =
  | "Estrategia"
  | "Regulacao"
  | "Produto"
  | "Mercado"
  | "Pessoas"
  | "Operacional"
  | "Pessoal";

export interface ClassificationResult {
  frente?: Frente | null;
  tipo?: ReuniaoTipo | null;
  categoria?: InsightCategoria | null;
  pessoas: string[];          // names of people mentioned (max ~10)
  organizacoes: string[];     // names of orgs mentioned (max ~10)
}

export interface PageToClassify {
  page_id: string;
  workspace: "personal" | "globalcripto" | "nora";
  db: "Reunioes" | "Insights";
  title: string;
  body: string;                // text extracted from properties + blocks
  current_props: {
    frente: string | null;
    tipo: string | null;
    categoria: string | null;
    fonte_tipo: string | null;
  };
}
