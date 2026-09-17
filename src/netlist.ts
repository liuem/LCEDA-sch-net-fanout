/**
 * Protel2 网表解析 / Protel2 netlist parser
 *
 * 用于判断"引脚当前已有网络"：出现在任一网络里的 `位号-引脚号`
 * 即视为已连接（含导线相连但无显式命名的自动网络名）。
 *
 * Protel2 格式（sch_Netlist.getNetlist('Protel2') 返回文本）：
 *   [
 *   U1
 *   器件封装
 *   8
 *
 *   ]
 *   (
 *   VCC
 *   2
 *   U1-8
 *   U2-8
 *   )
 *
 * 解析只关心 (...) 网络块：块内首行为网络名，其后 `DES-PIN` 行为成员。
 * 解析失败的行直接忽略，保证脏数据不炸。
 */

/** 解析结果：`位号-引脚号`（位号原样保留大小写） -> 网络名 */
export function parseProtel2Netlist(text: string): Map<string, string> {
	const map = new Map<string, string>();
	if (!text || typeof text !== 'string')
		return map;

	const lines = text.split(/\r?\n/).map(l => l.trim());
	let inNet = false;
	let netName = '';

	for (const line of lines) {
		if (line === '' || line === '[') {
			inNet = false;
			continue;
		}
		if (line === '(') {
			inNet = true;
			netName = '';
			continue;
		}
		if (line === ')') {
			inNet = false;
			continue;
		}
		if (!inNet)
			continue;
		if (netName === '') {
			// 网络块首行 = 网络名（去除引号）
			netName = line.replace(/^["']|["']$/g, '');
			continue;
		}
		// 成员行：位号-引脚号。位号可含 '-'，引脚号取最后一个 '-' 之后
		const m = line.match(/^(\S+)-([^\s-]+)$/);
		if (m && netName)
			map.set(`${m[1]}-${m[2]}`, netName);
	}
	return map;
}
