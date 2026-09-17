import type { FanoutPlan } from './types.ts';
/**
 * 原理图引脚网络扇出 扩展入口 / Entry
 *
 * 用法：在原理图中选中 MCU/FPGA 等多引脚器件，点击菜单
 * 「创建元件引脚名网络」：为所有尚未有网络的引脚创建以引脚名命名
 * 的网络（引出导线 + 网络标签/端口）。电源地等可配忽略名单，
 * 长引脚名可按分隔符取段，支持前后缀与跟随鼠标放置。
 */
import {
	applyPlan,
	cleanupCreated,
	createEdaHooks,
	getCurrentMousePosition,
	getExistingState,
	getSelectedComponents,
	loadConfig,
} from './eda-adapter.ts';
import { planNetFanout, planSummary } from './planner.ts';

declare const eda: any;

/* ---------------- 对话框 Promise 封装 ---------------- */

function askConfirm(content: string, title: string): Promise<boolean> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showConfirmationMessage(content, title, '确定', '取消', (main: boolean) => resolve(main));
	});
}

function info(content: string, title: string): void {
	eda.sys_Dialog.showInformationMessage(content, title);
}

function toast(msg: string): void {
	eda.sys_ToastMessage.showMessage(msg, 0 /* INFO */);
}

/* ---------------- 设置面板 ---------------- */

function configSummary(cfg: ReturnType<typeof loadConfig>): string {
	return [
		`名称：${cfg.separator ? `按 "${cfg.separator}" 取第 ${cfg.segmentIndex} 段` : '不分段'}${cfg.prefix ? `，前缀 "${cfg.prefix}"` : ''}${cfg.suffix ? `，后缀 "${cfg.suffix}"` : ''}`,
		`忽略名单：${cfg.ignoreList || '（空）'}`,
		`放置：${cfg.placement === 'follow' ? '跟随鼠标（标签列锚定鼠标位置）' : `直接放在引脚上（引出 ${cfg.wireLength} 单位）`}`,
		`网络名形式：${{ auto: '自动（v4 定位标签，v3 导线原生网络名）', netlabel: '网络标签（需 v4+）', netport: '网络端口', none: '仅导线带网络名' }[cfg.labelStyle]}`,
		`跳过"不连接(No ERC)"引脚：${cfg.skipNoConnect ? '开' : '关'}，网格 ${cfg.snapGrid} 单位`,
	].join('\n');
}

/** 设置面板（iframe 图形界面，经 eda.sys_Storage 共享存储直接读写配置） */
export async function openSettingsPanel(): Promise<void> {
	await eda.sys_IFrame.openIFrame('/iframe/settings.html', 560, 620, 'sch-netfanout-settings', {
		maximizeButton: false,
		minimizeButton: true,
		title: '引脚网络扇出设置',
	});
}

/* ---------------- 主流程 ---------------- */

function detailLines(plan: FanoutPlan, limit = 40): string {
	const rows = plan.items.slice(0, limit).map(it =>
		`${it.designator}-${it.pinNumber} ${it.pinName} -> 网络 ${it.net}（${it.dir === 'left' ? '左' : it.dir === 'right' ? '右' : it.dir === 'up' ? '上' : '下'}向引出，导线 [${it.wire.join(', ')}]）`);
	const skipRows = plan.skips.slice(0, Math.max(limit - rows.length, 6)).map(s => `跳过 ${s.designator}-${s.pinNumber} ${s.pinName}：${s.reason}`);
	const more = (plan.items.length + plan.skips.length) > (rows.length + skipRows.length)
		? `\n… 共 ${plan.items.length} 项创建 / ${plan.skips.length} 项跳过`
		: '';
	return [...rows, ...skipRows].join('\n') + more;
}

/** 提取 + 规划（预览与执行共用） */
async function buildPlan(onProgress?: (pct: number, msg: string) => void): Promise<FanoutPlan> {
	onProgress?.(5, '读取选中器件…');
	const comps = await getSelectedComponents();
	if (!comps.length)
		throw new Error('没有选中的器件（请先在原理图中选中一个或多个普通器件；网络标号/端口不算）');
	const pinCount = comps.reduce((n, c) => n + c.pins.length, 0);
	if (!pinCount)
		throw new Error('选中器件没有可读到的引脚');

	onProgress?.(30, '读取网表与已有导线…');
	const existing = await getExistingState();

	const cfg = loadConfig();
	let anchor: { x: number; y: number } | undefined;
	if (cfg.placement === 'follow') {
		anchor = await getCurrentMousePosition();
		if (!anchor)
			throw new Error('跟随鼠标模式需要鼠标在画布上（未取到鼠标位置）');
	}
	onProgress?.(60, `规划 ${pinCount} 个引脚…`);
	const plan = planNetFanout(comps, existing, cfg, anchor);
	console.log(
		`[sch-netfanout] 规划汇总：器件 ${comps.length}（${comps.map(c => `${c.designator}×${c.pins.length}脚`).join('、')}）`
		+ `，创建 ${plan.items.length}，跳过 ${plan.skips.length}，同名网络 ${plan.duplicates.length} 组`,
	);
	return plan;
}

/** 预览：不修改画布 */
export async function previewNetFanout(): Promise<void> {
	eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '分析选中器件…');
	try {
		const cfg = loadConfig();
		const plan = await buildPlan((pct, msg) => eda.sys_LoadingAndProgressBar.showProgressBar(pct, msg));
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		info(
			`${planSummary(plan, cfg)}\n\n明细：\n${detailLines(plan)}\n\n（预览未修改画布，执行「创建元件引脚名网络」生效）`,
			'引脚网络扇出预览',
		);
	}
	catch (e) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		info(`预览失败：${e instanceof Error ? e.message : String(e)}`, '引脚网络扇出预览');
	}
}

/** 创建元件引脚名网络（主命令） */
export async function runNetFanout(): Promise<void> {
	const cfg = loadConfig();
	try {
		eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '分析选中器件…');
		const plan = await buildPlan((pct, msg) => eda.sys_LoadingAndProgressBar.showProgressBar(pct, msg));
		eda.sys_LoadingAndProgressBar.destroyProgressBar();

		if (!plan.items.length) {
			info(`没有需要创建网络的引脚。\n\n${planSummary(plan, cfg)}`, '引脚网络扇出');
			return;
		}

		if (!(await askConfirm(
			`将为 ${plan.items.length} 个引脚创建以引脚名命名的网络（引出导线 + ${cfg.labelStyle === 'none' ? '导线网络名' : '网络标签/端口'}）。\n\n${configSummary(cfg)}\n\n建议先「预览」确认。继续？`,
			'原理图引脚网络扇出',
		))) {
			return;
		}

		eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '创建网络…');
		const result = await applyPlan(plan, cfg, createEdaHooks(), (done, total, msg) =>
			eda.sys_LoadingAndProgressBar.showProgressBar(60 + Math.round((done / Math.max(total, 1)) * 35), msg));
		eda.sys_LoadingAndProgressBar.destroyProgressBar();

		const labelNote = result.labelFailed
			? `，${result.labelFailed} 个网络标签/端口创建失败（导线已带网络名，不影响电气连接）`
			: '';
		const abortNote = result.labelAborted
			? '\n\n⚠ 当前客户端连续创建网络标签/端口失败，已自动熔断（余下仅创建导线）。V3.2 客户端建议在「设置面板 → 网络名可见形式」改回"自动"：导线原生网络名全版本可用且画布直接显示名称。'
			: '';
		const failNote = result.failed
			? `\n\n失败明细（可重跑本命令补齐，已完成部分自动跳过）：\n${result.failedItems.slice(0, 30).join('、')}${result.failedItems.length > 30 ? ` 等 ${result.failedItems.length} 项` : ''}`
			: '';
		toast(`完成：创建网络 ${result.applied} 个${result.failed ? `，失败 ${result.failed} 个` : ''}${labelNote}`);
		info(
			`完成：创建网络 ${result.applied} 个${result.failed ? `，失败 ${result.failed} 个` : ''}${labelNote}。\n\n${planSummary(plan, cfg)}${abortNote}${failNote}\n\n明细：\n${detailLines(plan)}`,
			'原理图引脚网络扇出',
		);
	}
	catch (e) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		info(
			`创建失败：${e instanceof Error ? e.message : String(e)}\n\n提示：请确认已打开原理图编辑器并选中器件。`,
			'原理图引脚网络扇出',
		);
	}
}

/** 删除本插件创建的导线/网络端口 */
export async function cleanupNetFanout(): Promise<void> {
	if (!(await askConfirm(
		'将删除本插件历史创建的全部引出导线与网络端口（不影响手工绘制内容；网络标签为属性图元，API 暂不支持单独删除，随导线删除后失效，如有残留可框选删除）。继续？',
		'清理',
	))) {
		return;
	}
	try {
		const n = await cleanupCreated();
		toast(n.wires || n.ports ? `已删除导线 ${n.wires} 条、网络端口 ${n.ports} 个` : '没有可清理的记录');
	}
	catch (e) {
		info(`清理失败：${e instanceof Error ? e.message : String(e)}`, '清理');
	}
}

/**
 * 诊断：把每个引脚的原始数据（名称/编号/坐标/No ERC）与规划去向
 * 输出到控制台，用于排查"为什么这个引脚没创建网络"。
 */
export async function dumpDiagnostics(): Promise<void> {
	eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '提取选中器件…');
	try {
		const cfg = loadConfig();
		const comps = await getSelectedComponents();
		const existing = await getExistingState();
		const plan = planNetFanout(comps, existing, cfg, await getCurrentMousePosition());
		eda.sys_LoadingAndProgressBar.destroyProgressBar();

		const lines: string[] = [];
		for (const comp of comps) {
			for (const pin of comp.pins) {
				const key = `${comp.designator}-${pin.pinNumber}`;
				const item = plan.items.find(it => it.designator === comp.designator && it.pinNumber === pin.pinNumber);
				const skip = plan.skips.find(s => s.designator === comp.designator && s.pinNumber === pin.pinNumber);
				const net = existing.pinNets.get(key);
				const dest = item
					? `创建 ${item.net}（${item.dir}，[${item.wire.join(',')}]）`
					: skip
						? `跳过 ${skip.reason}`
						: '未处理';
				lines.push(
					`${comp.designator}-${pin.pinNumber} name="${pin.pinName}" (${pin.x},${pin.y}) rot=${pin.rotation ?? '?'}`
					+ `${pin.noConnect ? ' [NoERC]' : ''}${net ? ` net=${net}` : ''} -> ${dest}`,
				);
			}
		}
		console.log(`[sch-netfanout] 诊断明细（${lines.length} 个引脚）：\n${lines.join('\n')}`);
		info(
			`诊断明细（${lines.length} 个引脚）已输出到控制台。\n\n查看/复制：EDA Pro 菜单「设置 - 扩展 - 开发者工具」打开 DevTools，Console 过滤 "sch-netfanout"。\n\n汇总：\n${planSummary(plan, cfg)}`,
			'诊断',
		);
	}
	catch (e) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		info(`诊断失败：${e instanceof Error ? e.message : String(e)}`, '诊断');
	}
}

export function about(): void {
	const cfg = loadConfig();
	info(
		'原理图引脚网络扇出（LCEDA-sch-net-fanout）\n\n'
		+ '选中 MCU/FPGA 等多引脚器件，一键为所有尚未有网络的引脚创建以引脚名命名的网络：自动判断引脚朝向并沿朝向引出导线（保证直接连上管脚），网络名支持分隔符取段、前后缀与电源地忽略名单；标签可直接放在引脚上或锚定鼠标位置成列对齐。\n\n'
		+ `当前配置：\n${configSummary(cfg)}\n\n单位：原理图 1 单位 = 0.01 英寸 = 10mil；默认网络名形式为网络标签（客户端不支持时自动回退网络端口）。`,
		'关于',
	);
}
