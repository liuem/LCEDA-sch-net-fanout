import type { Dir4, ExistingState, FanoutConfig, FanoutPlan, PlanItem, SchCompInfo, SkipItem } from './types.ts';
/**
 * 扇出规划 / Fanout planner（纯函数，离线可测）
 *
 * 输入：选中器件（含引脚与外接盒）、已有电气状态（网表 + 已有导线顶点）、
 * 配置、follow 模式锚点（鼠标位置）。
 * 输出：逐引脚的"网络名 + 承载导线 + 标签位置"计划与跳过明细。
 *
 * 跳过条件（按序）：
 *   1. 引脚名与引脚号都为空 —— 无法命名
 *   2. 带"不连接(No ERC)"标记且配置跳过
 *   3. 完整引脚名或分段基名命中忽略名单（电源/地/NC）
 *   4. 网表显示该引脚已属某网络
 *   5. 已有导线顶点贴合该引脚端点
 */
import { directWire, followWire, pointOnAnyWire, resolvePinDirections } from './geometry.ts';
import { deriveNetName, estimateNetWidth, isPinIgnored, nameOptionsOf, parseIgnoreList } from './pin-name.ts';

/** 引出方向人工校正（自动判向残余误判时的一键纠正） */
const DIR_CORRECTIONS: Record<string, (d: Dir4) => Dir4> = {
	none: d => d,
	swapLR: (d) => {
		if (d === 'left')
			return 'right';
		if (d === 'right')
			return 'left';
		return d;
	},
	swapUD: (d) => {
		if (d === 'up')
			return 'down';
		if (d === 'down')
			return 'up';
		return d;
	},
	rotate180: (d) => {
		switch (d) {
			case 'left': return 'right';
			case 'right': return 'left';
			case 'up': return 'down';
			case 'down': return 'up';
		}
	},
};

export function correctDir(dir: Dir4, cfg: FanoutConfig): Dir4 {
	const fn = DIR_CORRECTIONS[cfg.dirCorrection] ?? DIR_CORRECTIONS.none;
	return fn(dir);
}

export function planNetFanout(
	comps: SchCompInfo[],
	existing: ExistingState,
	cfg: FanoutConfig,
	anchor?: { x: number; y: number },
): FanoutPlan {
	const opts = nameOptionsOf(cfg);
	const ignorePatterns = parseIgnoreList(cfg.ignoreList);
	const items: PlanItem[] = [];
	const skips: SkipItem[] = [];
	const grid = cfg.snapGrid > 0 ? cfg.snapGrid : 10;

	for (const comp of comps) {
		// 器件内全部引脚的朝向一次解析（rotation 分组优先，点云级联兜底）
		const dirs = resolvePinDirections(comp.pins, comp.bbox);
		// 跟随模式的钳位边界：外接盒 ∪ 引脚点云（API 盒可能缩在引脚以内）
		const pinXs = comp.pins.map(p => p.x);
		const pinYs = comp.pins.map(p => p.y);
		const bounds = {
			minX: Math.min(comp.bbox.minX, ...pinXs),
			minY: Math.min(comp.bbox.minY, ...pinYs),
			maxX: Math.max(comp.bbox.maxX, ...pinXs),
			maxY: Math.max(comp.bbox.maxY, ...pinYs),
		};
		for (let pi = 0; pi < comp.pins.length; pi++) {
			const pin = comp.pins[pi];
			const pinName = String(pin.pinName ?? '').trim();
			const pinNumber = String(pin.pinNumber ?? '').trim();
			const displayName = pinName || pinNumber;
			const key = `${comp.designator}-${pinNumber}`;

			if (!pinName && !pinNumber) {
				skips.push({ designator: comp.designator, pinNumber, pinName, reason: '引脚无名（名称与编号均为空）' });
				continue;
			}
			if (cfg.skipNoConnect && pin.noConnect) {
				skips.push({ designator: comp.designator, pinNumber, pinName: displayName, reason: '带"不连接(No ERC)"标记' });
				continue;
			}
			const hit = isPinIgnored(displayName, ignorePatterns, opts);
			if (hit) {
				skips.push({ designator: comp.designator, pinNumber, pinName: displayName, reason: `忽略名单命中：${hit}` });
				continue;
			}
			const netInNetlist = existing.pinNets.get(key);
			if (netInNetlist) {
				skips.push({ designator: comp.designator, pinNumber, pinName: displayName, reason: `已有网络 ${netInNetlist}` });
				continue;
			}
			if (pointOnAnyWire(pin.x, pin.y, existing.wirePoints)) {
				skips.push({ designator: comp.designator, pinNumber, pinName: displayName, reason: '已有导线连接' });
				continue;
			}

			const net = deriveNetName(displayName, opts);
			if (!net) {
				skips.push({ designator: comp.designator, pinNumber, pinName: displayName, reason: '生成的网络名为空' });
				continue;
			}

			const dir = correctDir(dirs[pi] ?? 'right', cfg);
			// 左/上引出：网络标签文字左下角锚定在导线外端、向右压线延伸，
			// 导线须长过文字宽度（网格向上取整），否则标签锚点/文字出线导致网络绑定丢失
			let wireLen = cfg.wireLength;
			if (dir === 'left' || dir === 'up') {
				const need = estimateNetWidth(net) + 2;
				if (need > wireLen)
					wireLen = Math.ceil(need / grid) * grid;
			}
			const geo = cfg.placement === 'follow' && anchor
				? followWire(pin.x, pin.y, dir, anchor, bounds, grid, cfg.wireLength)
				: directWire(pin.x, pin.y, dir, wireLen, grid);

			items.push({ designator: comp.designator, pinNumber, pinName: displayName, net, dir, wire: geo.wire, label: geo.label });
		}
	}

	// 同名网络统计（多引脚共享同一网络名，例如电源分段后同名或同名引脚）
	const counts = new Map<string, number>();
	for (const it of items)
		counts.set(it.net, (counts.get(it.net) ?? 0) + 1);
	const duplicates = [...counts.entries()]
		.filter(([, n]) => n > 1)
		.map(([net, count]) => ({ net, count }))
		.sort((a, b) => b.count - a.count);

	return {
		items,
		skips,
		duplicates,
		anchor: cfg.placement === 'follow' && anchor ? { x: anchor.x, y: anchor.y } : undefined,
	};
}

/** 汇总文本（预览/完成对话框共用） */
export function planSummary(plan: FanoutPlan, cfg: FanoutConfig): string {
	const byReason = new Map<string, number>();
	for (const s of plan.skips)
		byReason.set(s.reason.replace(/：.*$/, ''), (byReason.get(s.reason.replace(/：.*$/, '')) ?? 0) + 1);
	const skipLines = [...byReason.entries()].map(([r, n]) => `${r} ${n}`).join('、');
	return [
		`创建网络 ${plan.items.length} 个，跳过 ${plan.skips.length} 个${skipLines ? `（${skipLines}）` : ''}`,
		`名称规则：${cfg.separator ? `按 "${cfg.separator}" 取第 ${cfg.segmentIndex} 段` : '不分段'}`
		+ `${cfg.prefix ? ` + 前缀 "${cfg.prefix}"` : ''}${cfg.suffix ? ` + 后缀 "${cfg.suffix}"` : ''}`,
		`放置：${cfg.placement === 'follow' ? `跟随鼠标（标签列锚定 ${plan.anchor ? `(${plan.anchor.x}, ${plan.anchor.y})` : '鼠标位置'}）` : `直接放在引脚上（引出 ${cfg.wireLength} 单位）`}`,
		plan.duplicates.length ? `同名网络 ${plan.duplicates.length} 组（${plan.duplicates.map(d => `${d.net}×${d.count}`).join('、')}）——同名即同网，请确认是否预期` : '',
	].filter(Boolean).join('\n');
}
