import type { ExistingState, FanoutConfig, FanoutPlan, SchCompInfo } from './types.ts';
import { wireVertices } from './geometry.ts';
/**
 * EDA 运行时适配层 / EDA runtime adapter
 *
 * 职责：
 * - 读取选中器件（含引脚端点与外接盒）与已有电气状态（网表 + 导线顶点）
 * - 把扇出计划写回画布（创建带网络名的导线 + 网络标签/网络端口）
 * - 记录本插件创建的图元 ID，供一键清理
 *
 * 写回操作通过 ApplyHooks 注入（生产环境包装全局 eda，测试注入模拟实现）。
 * 坐标单位：原理图画布 1 单位 = 0.01 英寸 = 10mil。
 */
import { parseProtel2Netlist } from './netlist.ts';
import { estimateNetWidth } from './pin-name.ts';
import { DEFAULT_CONFIG } from './types.ts';

/** 全局 eda 对象由扩展运行时注入 */
declare const eda: any;

/* ------------------------- 配置存取 ------------------------- */

const CONFIG_KEY = 'schNetFanoutConfig';

export function loadConfig(): FanoutConfig {
	let saved = eda.sys_Storage.getExtensionUserConfig(CONFIG_KEY);
	if (typeof saved === 'string' && saved.trim().startsWith('{')) {
		try {
			saved = JSON.parse(saved);
		}
		catch { /* 保持原值 */ }
	}
	const cfg = { ...DEFAULT_CONFIG, ...(saved && typeof saved === 'object' ? saved : {}) };
	if (cfg.placement !== 'follow')
		cfg.placement = 'direct';
	if (!['none', 'swapLR', 'swapUD', 'rotate180'].includes(cfg.dirCorrection))
		cfg.dirCorrection = 'none';
	if (!['auto', 'netlabel', 'netport', 'none'].includes(cfg.labelStyle))
		cfg.labelStyle = 'auto';
	if (cfg.labelAlign !== 'native')
		cfg.labelAlign = 'auto';
	if (!Number.isFinite(cfg.segmentIndex) || cfg.segmentIndex === 0)
		cfg.segmentIndex = 1;
	if (!Number.isFinite(cfg.wireLength) || cfg.wireLength <= 0)
		cfg.wireLength = DEFAULT_CONFIG.wireLength;
	if (!Number.isFinite(cfg.snapGrid) || cfg.snapGrid <= 0)
		cfg.snapGrid = DEFAULT_CONFIG.snapGrid;
	if (!Number.isFinite(cfg.createIntervalMs) || cfg.createIntervalMs < 0)
		cfg.createIntervalMs = DEFAULT_CONFIG.createIntervalMs;
	if (!Number.isFinite(cfg.maxRetries) || cfg.maxRetries < 0)
		cfg.maxRetries = DEFAULT_CONFIG.maxRetries;
	cfg.prefix = String(cfg.prefix ?? '');
	cfg.suffix = String(cfg.suffix ?? '');
	cfg.separator = String(cfg.separator ?? '');
	cfg.ignoreList = String(cfg.ignoreList ?? DEFAULT_CONFIG.ignoreList);
	return cfg;
}

export async function saveConfig(cfg: FanoutConfig): Promise<boolean> {
	await eda.sys_Storage.setExtensionUserConfig(CONFIG_KEY, JSON.stringify(cfg));
	const back = eda.sys_Storage.getExtensionUserConfig(CONFIG_KEY);
	return typeof back === 'string' && back.includes('"separator"');
}

/* ------------------------- 画布状态提取 ------------------------- */

/**
 * 读取选中器件（普通器件 'part'；网络标号/网络端口等特殊件排除）。
 * 若只选中了引脚（ComponentPin），自动反查所属器件。
 */
export async function getSelectedComponents(): Promise<SchCompInfo[]> {
	const selected = (await eda.sch_SelectControl.getAllSelectedPrimitives()) ?? [];
	const compPrims: any[] = [];
	const pinPrims: any[] = [];
	for (const p of selected) {
		try {
			const t = p.getState_PrimitiveType?.();
			if (t === 'Component')
				compPrims.push(p);
			else if (t === 'ComponentPin')
				pinPrims.push(p);
		}
		catch { /* 单个失败跳过 */ }
	}

	// 只选了引脚：反查全部器件的引脚表定位父器件
	if (!compPrims.length && pinPrims.length) {
		const pinIds = new Set(pinPrims.map(p => String(p.getState_PrimitiveId?.() ?? '')));
		const all = (await eda.sch_PrimitiveComponent.getAll?.()) ?? [];
		for (const c of all) {
			try {
				const pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.getState_PrimitiveId())) ?? [];
				if (pins.some(pin => pinIds.has(String(pin.getState_PrimitiveId?.() ?? '')))) {
					compPrims.push(c);
					if (compPrims.length >= pinIds.size)
						break;
				}
			}
			catch { /* ignore */ }
		}
	}

	const comps: SchCompInfo[] = [];
	for (const p of compPrims) {
		try {
			const ctype = p.getState_ComponentType?.();
			if (ctype && ctype !== 'part')
				continue; // 网络标号/端口/图框等非普通器件
			const designator = String(p.getState_Designator?.() ?? '').trim();
			const id = String(p.getState_PrimitiveId?.() ?? '');
			if (!designator || !id)
				continue;
			const rawPins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)) ?? [];
			const pins = rawPins.map((pin: any) => ({
				pinNumber: String(pin.getState_PinNumber?.() ?? '').trim(),
				pinName: String(pin.getState_PinName?.() ?? '').trim(),
				x: Number(pin.getState_X?.()),
				y: Number(pin.getState_Y?.()),
				noConnect: pin.getState_NoConnected?.() === true,
				rotation: Number.isFinite(Number(pin.getState_Rotation?.())) ? Number(pin.getState_Rotation()) : undefined,
			})).filter((pin: any) => Number.isFinite(pin.x) && Number.isFinite(pin.y));
			let bbox = await eda.sch_Primitive.getPrimitivesBBox([id]);
			if (!bbox) {
				// 外接盒读取失败：用引脚端点凸包近似
				const xs = pins.map((pin: any) => pin.x);
				const ys = pins.map((pin: any) => pin.y);
				bbox = xs.length
					? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
					: undefined;
			}
			if (!bbox)
				continue;
			comps.push({ primitiveId: id, designator, bbox, pins });
		}
		catch (e) {
			console.warn('[sch-netfanout] 读取选中器件失败:', e);
		}
	}
	return comps;
}

/** 已有电气状态：网表（引脚->网络） + 已有导线顶点 */
export async function getExistingState(): Promise<ExistingState> {
	const pinNets = new Map<string, string>();
	try {
		const netlist = await eda.sch_Netlist.getNetlist('Protel2');
		for (const [k, v] of parseProtel2Netlist(String(netlist ?? '')))
			pinNets.set(k, v);
	}
	catch (e) {
		console.warn('[sch-netfanout] 网表读取失败（仅按导线几何判断已连接）:', e);
	}

	const wirePoints: Array<{ x: number; y: number }> = [];
	try {
		const wires = (await eda.sch_PrimitiveWire.getAll?.()) ?? [];
		for (const w of wires) {
			try {
				wirePoints.push(...wireVertices(w.getState_Line?.()));
			}
			catch { /* ignore */ }
		}
	}
	catch (e) {
		console.warn('[sch-netfanout] 导线读取失败:', e);
	}
	return { pinNets, wirePoints };
}

/** 当前鼠标位置（follow 模式锚点） */
export async function getCurrentMousePosition(): Promise<{ x: number; y: number } | undefined> {
	try {
		return await eda.sch_SelectControl.getCurrentMousePosition();
	}
	catch {
		return undefined;
	}
}

/* ------------------------- 计划写回（可注入 hooks） ------------------------- */

export interface ApplyHooks {
	/** 创建带网络名的导线，返回图元 ID */
	createWire: (line: number[], net: string) => Promise<string | undefined>;
	/** 创建网络标签（EDA v4+），返回图元 ID；不支持时返回 undefined */
	createNetLabel: (x: number, y: number, net: string) => Promise<string | undefined>;
	/** 创建网络端口（双向），返回图元 ID */
	createNetPort: (net: string, x: number, y: number) => Promise<string | undefined>;
	/** 客户端是否支持网络标签 API（缺省视为支持） */
	supportsNetLabel?: () => boolean;
	/**
	 * 移动导线原生网络标签到指定 x（v3.2：经属性图元 modify；
	 * 不支持或找不到标签时返回 false，保持原生位置）
	 */
	repositionWireLabel?: (wireId: string, net: string, x: number) => Promise<boolean>;
	deleteWires: (ids: string[]) => Promise<boolean>;
	deleteComponents: (ids: string[]) => Promise<boolean>;
}

/** 生产 hooks：包装全局 eda（能力探测 + 逐级回退） */
export function createEdaHooks(): ApplyHooks {
	return {
		async createWire(line, net) {
			const w = await eda.sch_PrimitiveWire.create(line, net);
			return w?.getState_PrimitiveId?.();
		},
		async createNetLabel(x, y, net) {
			const fn = eda.sch_PrimitiveAttribute?.createNetLabel;
			if (typeof fn !== 'function')
				return undefined;
			const label = await fn.call(eda.sch_PrimitiveAttribute, x, y, net);
			return label?.getState_PrimitiveId?.();
		},
		async createNetPort(net, x, y) {
			const port = await eda.sch_PrimitiveComponent.createNetPort('BI', net, x, y);
			return port?.getState_PrimitiveId?.();
		},
		supportsNetLabel() {
			return typeof eda.sch_PrimitiveAttribute?.createNetLabel === 'function';
		},
		async repositionWireLabel(wireId, net, x) {
			try {
				const attrApi = eda.sch_PrimitiveAttribute;
				if (!attrApi?.getAll || !attrApi?.modify)
					return false;
				const attrs = (await attrApi.getAll(wireId)) ?? [];
				const label = attrs.find((a: any) => String(a.getState_Value?.() ?? '') === net)
					?? attrs.find((a: any) => /net/i.test(String(a.getState_Key?.() ?? '')));
				if (!label)
					return false;
				const ok = await attrApi.modify(label, { x });
				return !!ok;
			}
			catch (e) {
				console.warn('[sch-netfanout] 移动原生网络标签失败（保持默认位置）:', e);
				return false;
			}
		},
		async deleteWires(ids) {
			if (!ids.length)
				return true;
			return eda.sch_PrimitiveWire.delete(ids);
		},
		async deleteComponents(ids) {
			if (!ids.length)
				return true;
			return eda.sch_PrimitiveComponent.delete(ids);
		},
	};
}

export interface ApplyResult {
	/** 成功创建承载导线的项数 */
	applied: number;
	/** 导线创建失败数 */
	failed: number;
	/** 标签/端口创建失败数（导线已带网络名，不影响电气） */
	labelFailed: number;
	/** 标签/端口连续失败被熔断（当前客户端不支持该形式） */
	labelAborted: boolean;
	/** 导线创建失败的项（`位号-引脚号(网络名)`），供结果对话框展示 */
	failedItems: string[];
	createdWireIds: string[];
	createdPortIds: string[];
}

/**
 * 网络名可见形式解析。
 *
 * 专业版的"网络标签"是虚拟图元：本质是导线的名称属性（放置标签=给导线
 * 设名），导线带网络名后画布原生显示该名称。因此：
 * - auto：客户端有 createNetLabel（EDA v4+，BETA，V3.2 尚未发布）时用它
 *   精确定位标签；否则就用导线原生网络名（全版本可用，零额外图元）。
 * - 显式 netlabel/netport/none 按用户选择，不做回退。
 */
export function resolveLabelStyle(cfg: FanoutConfig, hooks: ApplyHooks): 'netlabel' | 'netport' | 'none' {
	if (cfg.labelStyle === 'none')
		return 'none';
	if (cfg.labelStyle === 'netport')
		return 'netport';
	if (cfg.labelStyle === 'netlabel')
		return 'netlabel';
	// auto：v4 有 createNetLabel 就精确定位；v3 用导线原生虚拟网络标签
	return hooks.supportsNetLabel?.() ?? true ? 'netlabel' : 'none';
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 自适应节奏的创建控制器。
 *
 * 客户端画布对密集创建存在事务限流（实测：不限速时约连发 12 次后批量
 * 返回 undefined；固定 100ms 间隔仍会触发限流并靠重试硬扛，拖到约 1s/个）。
 * 策略：起步按 cfg.createIntervalMs；每次失败把当前节奏翻倍（100→200→400→…
 * 封顶 1200ms）后重试；连续 4 次成功则把节奏回落 30%（不低于起步值）。
 * 节奏自动收敛到画布真实吞吐，不浪费重试。
 */
export class AdaptivePacer {
	private pace: number;
	private streak = 0;
	private readonly minPace: number;
	private readonly maxPace: number;

	constructor(minPace: number, maxPace = 1200) {
		this.minPace = Math.max(0, minPace);
		this.maxPace = maxPace;
		this.pace = this.minPace;
	}

	/** 每次失败后调用：加大节奏，返回建议等待毫秒 */
	onFail(): number {
		this.streak = 0;
		this.pace = Math.min(Math.max(this.pace, 100) * 2, this.maxPace);
		return this.pace;
	}

	/** 每次成功后调用：连续成功时缓慢回落节奏 */
	onSuccess(): void {
		this.streak++;
		if (this.streak >= 4 && this.pace > this.minPace) {
			this.pace = Math.max(this.minPace, Math.round(this.pace * 0.7));
			this.streak = 0;
		}
	}

	/** 项间等待毫秒 */
	current(): number {
		return this.pace;
	}
}

export { estimateNetWidth };

/**
 * 分侧标签锚点 x（标签锚点=文字左下角，且必须落在导线上否则网络绑定丢失）：
 * 右/下引出 = 导线起点（引脚端），文字向右延伸出线外（锚点在线上，绑定保持）；
 * 左/上引出 = 导线外端点，文字向右沿导线延伸、右缘抵达引脚——导线长度由
 * planner 按文字宽度延长，保证文字全程压线（绑定不断）。
 */
export function labelAnchorX(dir: 'left' | 'right' | 'up' | 'down', startX: number, endX: number): number {
	if (dir === 'right' || dir === 'down')
		return startX;
	return endX;
}

/**
 * 应用计划到画布：逐项创建带网络名的导线（电气连接由导线起点落在引脚端点
 * 保证），再按配置在导线末端放网络标签/端口。
 * - 节奏自适应（见 AdaptivePacer），规避画布事务限流；
 * - 标签/端口连续失败 5 次自动熔断（如 V3.2.149 的 createNetPort 全军覆没），
 *   余下项目跳过标签创建并提示改用"自动"模式（导线原生网络名）；
 * - 标签定位（labelAlign=auto）：右/下引出文字从线端向外、左/上引出文字在
 *   线端向外结束——v4 用 createNetLabel 直接落位，v3 经属性图元 modify 移动
 *   原生标签，失败则保持编辑器原生位置；
 * - 标签失败不回滚导线——导线已携带网络名，电气上不受影响。
 */
export async function applyPlan(
	plan: FanoutPlan,
	cfg: FanoutConfig,
	hooks: ApplyHooks,
	onProgress?: (done: number, total: number, msg: string) => void,
): Promise<ApplyResult> {
	const style = resolveLabelStyle(cfg, hooks);
	const attempts = Math.max(1, Math.round(cfg.maxRetries) + 1);
	const pacer = new AdaptivePacer(cfg.createIntervalMs);
	const wireIds: string[] = [];
	const portIds: string[] = [];
	const failedItems: string[] = [];
	let failed = 0;
	let labelFailed = 0;
	let labelConsecutiveFails = 0;
	let labelAborted = false;

	async function createAdaptive<T>(fn: () => Promise<T | undefined>, tag: string): Promise<T | undefined> {
		for (let a = 0; a < attempts; a++) {
			const r = await fn();
			if (r !== undefined) {
				pacer.onSuccess();
				return r;
			}
			const wait = pacer.onFail();
			if (a < attempts - 1) {
				console.warn(`[sch-netfanout] ${tag} 未成功，${wait}ms 后重试（画布限流，节奏已放慢）`);
				await sleep(wait);
			}
		}
		return undefined;
	}

	for (let i = 0; i < plan.items.length; i++) {
		const it = plan.items[i];
		onProgress?.(i, plan.items.length, `创建网络 ${i + 1}/${plan.items.length}：${it.designator}-${it.pinNumber} (${it.net})`);
		try {
			const wireId = await createAdaptive(() => hooks.createWire(it.wire, it.net), `${it.net} 导线`);
			if (!wireId)
				throw new Error('创建导线失败（含重试）');
			wireIds.push(wireId);
			const anchorX = labelAnchorX(it.dir, it.wire[0], it.wire[it.wire.length - 2]);
			if (style === 'netlabel' && !labelAborted) {
				const labelId = await hooks.createNetLabel(anchorX, it.label.y, it.net);
				if (labelId) {
					labelConsecutiveFails = 0;
				}
				else {
					labelFailed++;
					labelConsecutiveFails++;
					console.warn(`[sch-netfanout] ${it.net} 的网络标签创建失败（导线已带网络名，不影响电气）`);
					if (labelConsecutiveFails >= 5) {
						labelAborted = true;
						console.warn('[sch-netfanout] 网络标签连续 5 次创建失败，已熔断：余下项目仅创建导线。当前客户端可能不支持该形式，请在设置中改回"自动"');
					}
				}
			}
			else if (style === 'netport' && !labelAborted) {
				const labelId = await hooks.createNetPort(it.net, it.label.x, it.label.y);
				if (labelId) {
					labelConsecutiveFails = 0;
					portIds.push(labelId);
				}
				else {
					labelFailed++;
					labelConsecutiveFails++;
					console.warn(`[sch-netfanout] ${it.net} 的网络端口创建失败（导线已带网络名，不影响电气）`);
					if (labelConsecutiveFails >= 5) {
						labelAborted = true;
						console.warn('[sch-netfanout] 网络端口连续 5 次创建失败，已熔断：余下项目仅创建导线。当前客户端可能不支持该形式，请在设置中改回"自动"');
					}
				}
			}
			else if (cfg.labelAlign === 'auto' && hooks.repositionWireLabel) {
				// 原生虚拟标签（style none）：分侧移动标签位置（失败静默保持原位）
				await hooks.repositionWireLabel(wireId, it.net, anchorX);
			}
		}
		catch (e) {
			failed++;
			failedItems.push(`${it.designator}-${it.pinNumber}(${it.net})`);
			console.warn(`[sch-netfanout] ${it.designator}-${it.pinNumber} (${it.net}) 失败:`, e);
		}
		if (i < plan.items.length - 1) {
			const wait = pacer.current();
			if (wait > 0)
				await sleep(wait);
		}
	}

	const result: ApplyResult = {
		applied: wireIds.length,
		failed,
		labelFailed,
		labelAborted,
		failedItems,
		createdWireIds: wireIds,
		createdPortIds: portIds,
	};
	await persistCreatedIds(wireIds, portIds);
	return result;
}

/* ------------------------- 创建记录（供清理） ------------------------- */

const CREATED_KEY = 'schNetFanoutCreatedIds';

function loadCreated(): { wires: string[]; ports: string[] } {
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(CREATED_KEY);
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (parsed && typeof parsed === 'object') {
			return {
				wires: Array.isArray(parsed.wires) ? parsed.wires : [],
				ports: Array.isArray(parsed.ports) ? parsed.ports : [],
			};
		}
	}
	catch { /* ignore */ }
	return { wires: [], ports: [] };
}

async function persistCreatedIds(wireIds: string[], portIds: string[]): Promise<void> {
	try {
		const cur = loadCreated();
		await eda.sys_Storage.setExtensionUserConfig(
			CREATED_KEY,
			JSON.stringify({ wires: [...cur.wires, ...wireIds], ports: [...cur.ports, ...portIds] }),
		);
	}
	catch (e) {
		console.warn('[sch-netfanout] 记录创建 ID 失败（不影响扇出结果）:', e);
	}
}

/** 删除本插件历史创建的导线/网络端口（网络标签为属性图元，API 暂不支持删除，随导线失效） */
export async function cleanupCreated(hooks: ApplyHooks = createEdaHooks()): Promise<{ wires: number; ports: number }> {
	const cur = loadCreated();
	if (!cur.wires.length && !cur.ports.length)
		return { wires: 0, ports: 0 };
	await hooks.deleteWires(cur.wires);
	await hooks.deleteComponents(cur.ports);
	await eda.sys_Storage.setExtensionUserConfig(CREATED_KEY, JSON.stringify({ wires: [], ports: [] }));
	return { wires: cur.wires.length, ports: cur.ports.length };
}
