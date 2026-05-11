import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { CalGuardConfigSchema, type CalGuardConfig } from "./schema.js";

const CALGUARD_DIR = join(homedir(), ".calguard");

/** 替换 ${ENV_VAR} 为环境变量值 */
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || "";
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value);
    }
    return result;
  }
  return obj;
}

/** 确保配置中路径的 ~/ 展开为绝对路径 */
function expandHome(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/^~(?=\/)/, homedir());
  }
  if (Array.isArray(obj)) {
    return obj.map(expandHome);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandHome(value);
    }
    return result;
  }
  return obj;
}

export function loadConfig(configPath: string): CalGuardConfig {
  const absolutePath = resolve(configPath);

  if (!existsSync(absolutePath)) {
    // 返回默认配置
    console.error(`[Config] 配置文件不存在: ${absolutePath}，使用默认配置`);
    return getDefaultConfig();
  }

  const raw = readFileSync(absolutePath, "utf-8");
  const parsed = parseYaml(raw);
  const withEnv = resolveEnvVars(parsed);
  const withHome = expandHome(withEnv);

  const result = CalGuardConfigSchema.safeParse(withHome);
  if (!result.success) {
    console.error("[Config] 配置校验失败:");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export function getDefaultConfig(): CalGuardConfig {
  return CalGuardConfigSchema.parse({});
}

/** 确保 ~/.calguard 目录存在，返回该路径 */
export function ensureDataDir(): string {
  if (!existsSync(CALGUARD_DIR)) {
    mkdirSync(CALGUARD_DIR, { recursive: true });
  }
  return CALGUARD_DIR;
}

/** 获取索引数据库路径 */
export function getDbPath(): string {
  return join(ensureDataDir(), "index.db");
}
