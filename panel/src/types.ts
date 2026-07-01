export interface ProjectMeta {
  id: string;
  name: string;
  lang: string;
  files: number;
  links: number;
  clusters: number;
  confidence: { extracted: number; inferred: number };
  savings: { costPerSession: number; tokens: number };
}

export interface GNode {
  id: string;
  label: string;
  community: number;
  origin: "extracted" | "inferred";
  degree: number;
}

export interface GLink {
  source: string;
  target: string;
}

export interface Cluster {
  id: number;
  label: string;
  size: number;
}

export interface GodNode {
  id: string;
  label: string;
  degree: number;
  community: number;
}

export interface WikiArticle {
  title: string;
  body: string;
}

export interface ProjectData {
  meta: ProjectMeta;
  nodes: GNode[];
  links: GLink[];
  godNodes: GodNode[];
  clusters: Cluster[];
  report: string;
  wiki?: { index: string; articles: WikiArticle[] } | null;
}

export interface Manifest {
  projects: ProjectMeta[];
  builtAt: string | null;
}
