// The archived scientific edition is independent of runtime/installer versions.
export const scientificPublication = {
  title: "Behavior Tracker: An Open-Source Computational Platform for Automated Behavioral Analysis in Rodent Experiments",
  authors: ["Gabriel Silva Santos", "Thiago Alves Vargas"],
  version: "0.1.7",
  doi: "10.5281/zenodo.24612625",
  url: "https://doi.org/10.5281/zenodo.24612625",
  releasedAt: "2026-11-27",
  displayDate: "27/11/2026",
} as const;

export const scientificReference = `Santos, Gabriel Silva; Vargas, Thiago Alves. (2026). ${scientificPublication.title} (Version ${scientificPublication.version}) [Software]. Zenodo.`;
