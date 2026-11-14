// OpenAPI の応答検証用ワーカー(worker_threads)。src/core/openapi.ts が起動する。
// 仕様の `pattern` などによる正規表現の暴走(ReDoS)でメインスレッドが止まらないよう、スキーマのコンパイルと検証は
// このスレッドで行い、時間切れならメイン側がスレッドごと破棄する。
// 実行時は tsup が Ajv ごと dist/openapi-worker.js にバンドルする(開発時はこのファイルを直接読む)。
import { parentPort } from "node:worker_threads";
import Ajv2020 from "ajv/dist/2020.js";

const MAX_ERRORS = 100;

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
  allowUnionTypes: true,
  logger: false,
});
/** スキーマのキー → コンパイル済みの validator */
const validators = new Map();

function text(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}

/** 違反の整形に必要な項目だけを返す(メイン側へ大きな値を渡さない) */
function slimError(error) {
  const params = {};
  if (error.params && typeof error.params === "object") {
    if ("missingProperty" in error.params) params.missingProperty = error.params.missingProperty;
    if ("additionalProperty" in error.params) {
      params.additionalProperty = error.params.additionalProperty;
    }
    if (Array.isArray(error.params.allowedValues)) {
      params.allowedValues = error.params.allowedValues.slice(0, 10);
    }
  }
  return {
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message,
    params,
  };
}

parentPort.on("message", (message) => {
  const { id, key, schema, value } = message;
  let phase = "compile";
  try {
    let validate = validators.get(key);
    if (validate === undefined) {
      if (schema === undefined) throw new Error("the schema was not sent");
      validate = ajv.compile(schema);
      validators.set(key, validate);
    }
    phase = "validate";
    const valid = validate(value) === true;
    const errors = valid ? [] : (validate.errors ?? []);
    parentPort.postMessage({
      id,
      ok: true,
      valid,
      total: errors.length,
      errors: errors.slice(0, MAX_ERRORS).map(slimError),
    });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, phase, error: text(error) });
  }
});

parentPort.postMessage({ ready: true });
