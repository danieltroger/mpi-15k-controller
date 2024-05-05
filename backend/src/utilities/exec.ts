import { promisify } from "util";
import { exec as imported_exec } from "child_process";

export const exec = promisify(imported_exec);
