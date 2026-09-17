/**
 * 引脚名 -> 网络名推导 / Pin name -> net name
 *
 * 纯函数模块，离线可测：
 * - 长引脚名按分隔符分段取段（如 "USART1_TX/PB6" 取 "/" 第 2 段 -> PB6）
 * - 前缀/后缀拼接（便于后续按名称搜索统一处理）
 * - 忽略名单匹配（整词、忽略大小写、支持 * 通配），对完整引脚名与
 *   分段后的基名都做匹配（"VDD/PA0" 这类混合名不会被电源段误伤，
 *   "PA0/VDD" 也会因电源段被整脚忽略）
 */
import type { FanoutConfig } from './types.ts';

/** 名称规则子集（测试与 planner 复用） */
export interface NameOptions {
	separator: string;
	segmentIndex: number;
	prefix: string;
	suffix: string;
}

/** 清洗单个名称：去首尾空白、内部连续空白折叠为下划线（网络名不宜含空格） */
function cleanName(raw: string): string {
	return raw.replace(/\s+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * 分段取基名：按分隔符切分后取第 segmentIndex 段。
 * - segmentIndex 1 起数；负数从尾部倒数（-1=最后一段）
 * - 未含分隔符或越界时钳位到首/末段；分隔符为空返回整体
 */
export function pickSegment(pinName: string, separator: string, segmentIndex: number): string {
	const name = cleanName(pinName);
	if (!separator || !name.includes(separator))
		return name;
	const parts = name.split(separator).map(p => cleanName(p)).filter(p => p !== '');
	if (!parts.length)
		return name;
	const len = parts.length;
	let idx = segmentIndex >= 0 ? segmentIndex - 1 : len + segmentIndex;
	if (idx < 0)
		idx = 0;
	if (idx > len - 1)
		idx = len - 1;
	return parts[idx];
}

/** 网络名 = 前缀 + 分段基名 + 后缀 */
export function deriveNetName(pinName: string, opts: NameOptions): string {
	return `${opts.prefix}${pickSegment(pinName, opts.separator, opts.segmentIndex)}${opts.suffix}`;
}

/** 解析忽略名单：逗号/分号/换行分隔，去空；支持 * 通配 */
export function parseIgnoreList(raw: string): string[] {
	return String(raw ?? '')
		.split(/[,;\n]/)
		.map(s => s.trim())
		.filter(s => s !== '');
}

/** 单个名称是否命中忽略项（忽略大小写整词；含 * 时按通配匹配） */
export function matchIgnore(name: string, patterns: string[]): string | undefined {
	const clean = cleanName(name).toLowerCase();
	if (!clean)
		return undefined;
	for (const pat of patterns) {
		const p = pat.toLowerCase();
		if (p.includes('*')) {
			const re = new RegExp(`^${p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
			if (re.test(clean))
				return pat;
		}
		else if (clean === p) {
			return pat;
		}
	}
	return undefined;
}

/**
 * 引脚是否应被忽略名单跳过：完整引脚名或分段基名任一命中即跳过
 *（前后缀不参与匹配——名单面向引脚语义名）。
 */
export function isPinIgnored(pinName: string, patterns: string[], opts: NameOptions): string | undefined {
	const base = pickSegment(pinName, opts.separator, opts.segmentIndex);
	return matchIgnore(pinName, patterns) ?? matchIgnore(base, patterns);
}

/** 从配置取名称规则子集 */
export function nameOptionsOf(cfg: FanoutConfig): NameOptions {
	return { separator: cfg.separator, segmentIndex: cfg.segmentIndex, prefix: cfg.prefix, suffix: cfg.suffix };
}

/**
 * 估算网络名文本宽度（原理图单位；默认字号 ASCII 约 7 单位/字符，略保守）。
 * 用于左/上引出的导线延长（文字压线时网络绑定才不断）与标签定位。
 */
export function estimateNetWidth(net: string): number {
	return Math.max(1, net.length) * 7;
}
