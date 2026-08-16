import fs from "node:fs";
import process from "node:process";

fs.rmSync(`${process.cwd()}/dist`, { recursive: true, force: true });
