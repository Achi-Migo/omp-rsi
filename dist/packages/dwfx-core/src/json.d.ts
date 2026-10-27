/**
 * dwfx-core - INV-4: JSON 无损安全落盘与确定性指纹
 *
 * 契约保证：
 * 1. 严格拒绝顶层 undefined 与非法不可序列化类型（BigInt/Symbol/Function/NaN/Infinity）
 * 2. 递归深度限制 <= 64，杜绝循环引用与爆栈
 * 3. 拒绝稀疏数组与特殊原型对象（Class 实例等）
 * 4. FNV-1a 32 位标准哈希计算确定性指纹
 */
export declare class MaterializeError extends Error {
    constructor(message: string);
}
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = {
    [key: string]: JsonValue;
};
export type JsonArray = JsonValue[];
/**
 * 将任意 JS 对象做安全快照校验，剥离合法 undefined 并拒绝非法类型。
 * @throws MaterializeError 若遇到不可序列化类型、非有限数值或深度溢出
 */
export declare function snapshotJsonValue(value: unknown, depth?: number): JsonValue;
/**
 * FNV-1a 32-bit 标准哈希（与 dsh-dwf 唯一事实源算法位级一致）
 */
export declare function fnv1a32(text: string): string;
