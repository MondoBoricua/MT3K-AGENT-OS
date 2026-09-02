export const destinationDir = (treeRoot: string, selectedDir: string) => selectedDir || treeRoot;

export const directorySelection = (treeRoot: string, selectedDir: string) => {
  const path = destinationDir(treeRoot, selectedDir);
  return { selectedDir: path, pathInput: path };
};

export const childPath = (dir: string, name: string) =>
  dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
