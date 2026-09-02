export const destinationDir = (treeRoot: string, selectedDir: string) => selectedDir || treeRoot;

export const childPath = (dir: string, name: string) =>
  dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
