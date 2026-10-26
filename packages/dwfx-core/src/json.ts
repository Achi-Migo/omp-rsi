/**
 * dwfx-core - INV-4: JSON 无损安全落盘与确定性指纹
 * 
 * 契约保证：
 * 1. 严格拒绝顶层 undefined 与非法不可序列化类型（BigInt/Symbol/Function/NaN/Infinity）
 * 2. 递归深度限制 <= 64，杜绝循环引用与爆栈
 * 3. 拒绝稀疏数组与特殊原型对象（Class 实例等）
 * 4. FNV-1a 32 位标准哈希计算确定性指纹
 */

export class MaterializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializeError';
  }
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

const MAX_DEPTH = 64;

/**
 * 将任意 JS 对象做安全快照校验，剥离合法 undefined 并拒绝非法类型。
 * @throws MaterializeError 若遇到不可序列化类型、非有限数值或深度溢出
 */
export function snapshotJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) {
    throw new MaterializeError(`max serialization depth ${MAX_DEPTH} exceeded`);
  }

  if (value === undefined) {
    if (depth === 0) {
      throw new MaterializeError('top-level undefined cannot be serialized to JSON');
    }
    return undefined as unknown as JsonValue;
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MaterializeError(`non-finite number ${value} cannot be serialized to JSON`);
    }
    return value;
  }

  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    throw new MaterializeError(`unsupported type "${typeof value}" cannot be serialized to JSON`);
  }

  if (Array.isArray(value)) {
    // 检查是否为稀疏数组（sparse array: keys 数量小于 length）
    let presentKeys = 0;
    for (const _ in value) presentKeys += 1;
    if (presentKeys !== value.length) {
      throw new MaterializeError('sparse arrays cannot be serialized to JSON');
    }

    const result: JsonArray = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = snapshotJsonValue(value[i], depth + 1);
      // JSON 规范中数组中的 undefined 会转为 null
      result.push(item === undefined ? null : item);
    }
    return result;
  }

  if (typeof value === 'object') {
    // 原型守卫：只允许 Object.prototype 或 null 原型的纯数据字典
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new MaterializeError(
        `objects with custom prototype "${proto?.constructor?.name ?? 'unknown'}" cannot be serialized to JSON`
      );
    }

    const result: JsonObject = {};
    for (const [key, val] of Object.entries(value)) {
      const child = snapshotJsonValue(val, depth + 1);
      if (child !== undefined) {
        result[key] = child;
      }
    }
    return result;
  }

  throw new MaterializeError(`value of type "${typeof value}" cannot be serialized to JSON`);
}

/**
 * FNV-1a 32-bit 标准哈希（与 dsh-dwf 唯一事实源算法位级一致）
 */
export function fnv1a32(text: string): string {
  let hash = 2166136261;
  for (const ch of text.trim()) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
