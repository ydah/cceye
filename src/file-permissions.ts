import fs from "fs";

export const protectPrivateDirectory = (directoryPath: string): void => {
  try {
    fs.chmodSync(directoryPath, 0o700);
  } catch (error) {
    if (process.platform === "win32") {
      return;
    }
    throw new Error(`could not secure directory permissions for ${directoryPath}`, { cause: error });
  }
};

export const protectPrivateFile = (filePath: string): void => {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (process.platform === "win32") {
      return;
    }
    throw new Error(`could not secure file permissions for ${filePath}`, { cause: error });
  }
};
