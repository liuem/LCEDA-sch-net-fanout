/**
 * 几何计算 / Geometry
 *
 * - 引脚朝向判定：
 *   主判据 = 引脚场边缘归属（同一器件全部引脚坐标构成的点云的 min/max 边），
 *   引脚端点落在点云最左列 -> 朝左……角点歧义（同时在两条边上）用"边上引脚
 *   多数派"消解（实测 Spartan7 类符号：左列 19 脚 vs 顶行若干脚，左上角
 *   引脚归左列）。单列/单行点云（连接器类符号）按器件中心定整侧方向。
 *   兜底 = 器件外接盒中心主轴（旧逻辑，点云失效时用）。
 *   该判定只依赖绝对坐标，天然兼容器件旋转/镜像。
 * - 导线生成：
 *   direct：沿朝向伸出 wireLength（网格对齐）；垂直于引出方向的坐标严格
 *   保持引脚原值（引脚可能在 5 偏移网格上，二次吸附会产生斜线）。
 *   follow：水平引脚引到鼠标 X 列、垂直引脚引到鼠标 Y 列（钳位到器件
 *           外接盒之外），标签在列上竖向对齐成排。
 */
import type { Dir4 } from './types.ts';

export interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** 数值吸附到网格 */
export function snap(v: number, grid: number): number {
	if (!grid || grid <= 0)
		return Math.round(v);
	return Math.round(v / grid) * grid;
}

/** 方向单位向量（原理图坐标 y 向下为正） */
export function dirVector(dir: Dir4): { dx: number; dy: number } {
	switch (dir) {
		case 'left': return { dx: -1, dy: 0 };
		case 'right': return { dx: 1, dy: 0 };
		case 'up': return { dx: 0, dy: -1 };
		case 'down': return { dx: 0, dy: 1 };
	}
}

/**
 * 兜底朝向：端点到外接盒中心的偏移，主轴决定方向。
 * 端点恰在中心（理论不该出现）时回退 'right'。
 * 注：对又高又宽的符号，边缘引脚会因 |dy|>|dx| 误判——
 * 仅作 resolvePinDirections 的兜底。
 */
export function outwardDirection(px: number, py: number, bbox: BBox): Dir4 {
	const cx = (bbox.minX + bbox.maxX) / 2;
	const cy = (bbox.minY + bbox.maxY) / 2;
	const dx = px - cx;
	const dy = py - cy;
	if (Math.abs(dx) < 1 && Math.abs(dy) < 1)
		return 'right';
	if (Math.abs(dx) >= Math.abs(dy))
		return dx >= 0 ? 'right' : 'left';
	return dy >= 0 ? 'down' : 'up';
}

/** 引脚坐标（子集，供朝向判定复用；rotation 为引脚旋转角，可缺省） */
export interface PinLike {
	x: number;
	y: number;
	rotation?: number;
}

/** 引脚场边缘判定容差（坐标为整数，容 2 防浮点噪声） */
const EDGE_TOL = 2;

interface FieldDir {
	dir: Dir4;
	/** 单候选或多数派角点 = 高置信 */
	confident: boolean;
}

/**
 * 引脚场边缘归属（次级判据），逐级级联：
 * 1) API 外接盒边缘——器件盒含引脚图形时最可靠（三角形排列的 3 脚器件
 *    只有它能分清哪排是边）；
 * 2) 引脚点云边缘——盒缩在引脚以内时（实测 Spartan7 的 API 盒不含引脚
 *    端点）只有点云能定位边缘；角点歧义用"边上引脚多数派"消解；
 * 3) 单列/单行点云按盒中心定整侧方向（连接器/双脚器件）；
 * 4) 兜底：并集中心主轴。
 */
function fieldEdgeDirections(pins: PinLike[], bbox?: BBox): FieldDir[] {
	const n = pins.length;
	if (!n)
		return [];
	const xs = pins.map(p => p.x);
	const ys = pins.map(p => p.y);
	const fMinX = Math.min(...xs);
	const fMaxX = Math.max(...xs);
	const fMinY = Math.min(...ys);
	const fMaxY = Math.max(...ys);
	const field: BBox = { minX: fMinX, minY: fMinY, maxX: fMaxX, maxY: fMaxY };
	const spreadX = fMaxX - fMinX;
	const spreadY = fMaxY - fMinY;

	const edgeCands = (p: PinLike, b: BBox): Dir4[] => {
		const c: Dir4[] = [];
		if (Math.abs(p.x - b.minX) <= EDGE_TOL)
			c.push('left');
		if (Math.abs(p.x - b.maxX) <= EDGE_TOL)
			c.push('right');
		if (Math.abs(p.y - b.minY) <= EDGE_TOL)
			c.push('up');
		if (Math.abs(p.y - b.maxY) <= EDGE_TOL)
			c.push('down');
		return c;
	};
	// 点云某边有跨度才认可该边候选（单列点云的上下沿不算边）
	const fieldCands = (p: PinLike): Dir4[] => {
		const c = edgeCands(p, field);
		return c.filter((d) => {
			if (d === 'left' || d === 'right')
				return spreadY > EDGE_TOL && spreadX > EDGE_TOL;
			return spreadX > EDGE_TOL && spreadY > EDGE_TOL;
		});
	};
	const fieldCount = (d: Dir4): number =>
		pins.reduce((acc, p) => acc + (fieldCands(p).includes(d) ? 1 : 0), 0);

	return pins.map((p) => {
		// 1) API 外接盒边缘
		if (bbox) {
			const bc = edgeCands(p, bbox);
			if (bc.length === 1)
				return { dir: bc[0], confident: true };
		}
		// 2) 点云边缘（含跨度门槛）
		const fc = fieldCands(p);
		if (fc.length === 1)
			return { dir: fc[0], confident: true };
		if (fc.length >= 2) {
			const sorted = [...fc].sort((a, b) => fieldCount(b) - fieldCount(a));
			if (fieldCount(sorted[0]) > fieldCount(sorted[1]))
				return { dir: sorted[0], confident: true };
		}
		// 3) 单列/单行点云：按盒中心整侧定方向
		if (bbox) {
			if (spreadX <= EDGE_TOL)
				return { dir: p.x < (bbox.minX + bbox.maxX) / 2 ? 'left' : 'right', confident: true };
			if (spreadY <= EDGE_TOL)
				return { dir: p.y < (bbox.minY + bbox.maxY) / 2 ? 'up' : 'down', confident: true };
		}
		// 4) 兜底：并集中心主轴
		const uni: BBox = bbox
			? { minX: Math.min(fMinX, bbox.minX), minY: Math.min(fMinY, bbox.minY), maxX: Math.max(fMaxX, bbox.maxX), maxY: Math.max(fMaxY, bbox.maxY) }
			: field;
		return { dir: outwardDirection(p.x, p.y, uni), confident: false };
	});
}

/**
 * 一并解析器件全部引脚的朝向。返回数组与入参 pins 逐下标对应。
 *
 * 主判据 = 引脚 rotation 分组 + 空间自校准：同侧引脚在符号里共享同一
 * rotation，按 rotation 分组后用组质心相对整体中心的主轴偏移定方向。
 * 该判据不依赖 rotation 角值约定（0°朝哪无所谓），天然兼容器件旋转/
 * 镜像（位置与角值同步变换）、参差引脚长（同侧分组不受影响）。
 * rotation 缺失或单一角值时退化为点云边缘级联（见 fieldEdgeDirections）。
 */
export function resolvePinDirections(pins: PinLike[], bbox?: BBox): Dir4[] {
	const n = pins.length;
	if (!n)
		return [];
	const field = fieldEdgeDirections(pins, bbox);

	// rotation 归一化分组（0-359，缺省不参与）
	const rots = pins.map(p => (Number.isFinite(p.rotation) ? ((Math.round(p.rotation) % 360) + 360) % 360 : null));
	const groups = new Map<number, number[]>();
	rots.forEach((r, i) => {
		if (r === null)
			return;
		const list = groups.get(r);
		if (list)
			list.push(i);
		else
			groups.set(r, [i]);
	});
	if (groups.size < 2)
		return field.map(f => f.dir); // 无 rotation 信息：点云边缘级联兜底

	// 整体中心与各组质心（用全部引脚，含无 rotation 的）
	const cx = pins.reduce((s, p) => s + p.x, 0) / n;
	const cy = pins.reduce((s, p) => s + p.y, 0) / n;
	const groupDir = new Map<number, Dir4>();
	for (const [r, idxs] of groups) {
		const gx = idxs.reduce((s, i) => s + pins[i].x, 0) / idxs.length;
		const gy = idxs.reduce((s, i) => s + pins[i].y, 0) / idxs.length;
		const dx = gx - cx;
		const dy = gy - cy;
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1)
			continue; // 组质心在整体中心（组跨两侧或信息不足）：不结论
		groupDir.set(r, Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
	}
	if (!groupDir.size)
		return field.map(f => f.dir);

	// rotation 组方向优先（符号作者意图）；组未结论的引脚退点云级联
	return pins.map((p, i) => {
		const r = rots[i];
		return r === null ? field[i].dir : (groupDir.get(r) ?? field[i].dir);
	});
}

/**
 * direct 模式导线：从引脚端点沿朝向伸出长度（吸附网格）。
 * 起点保持引脚端点原值；垂直方向的坐标同样保持原值
 * （引脚可能在 5 偏移网格上，二次吸附会产生斜线），
 * 仅沿引出方向的端点坐标做网格对齐。
 */
export function directWire(
	px: number,
	py: number,
	dir: Dir4,
	length: number,
	grid: number,
): { wire: number[]; label: { x: number; y: number } } {
	const v = dirVector(dir);
	const len = Math.max(snap(length, grid), grid);
	let ex: number;
	let ey: number;
	if (v.dx !== 0) {
		ex = snap(px + v.dx * len, grid);
		ey = py;
	}
	else {
		ex = px;
		ey = snap(py + v.dy * len, grid);
	}
	return { wire: [px, py, ex, ey], label: { x: ex, y: ey } };
}

/** 吸附到网格（向小） */
function snapDown(v: number, grid: number): number {
	if (!grid || grid <= 0)
		return Math.floor(v);
	return Math.floor(v / grid) * grid;
}

/** 吸附到网格（向大） */
function snapUp(v: number, grid: number): number {
	if (!grid || grid <= 0)
		return Math.ceil(v);
	return Math.ceil(v / grid) * grid;
}

/**
 * follow 模式导线：水平引脚水平引到鼠标 X 列，垂直引脚垂直引到鼠标 Y 列。
 * 锚点列钳位到器件外接盒之外至少 minLen（默认 3 格）——鼠标在器件内部或
 * 贴边时，标签列自动退到器件外足够距离处，避免产出几个单位长的短桩。
 */
export function followWire(
	px: number,
	py: number,
	dir: Dir4,
	anchor: { x: number; y: number },
	bbox: BBox,
	grid: number,
	minLen = 0,
): { wire: number[]; label: { x: number; y: number } } {
	const gap = Math.max(snap(minLen > 0 ? minLen : grid * 3, grid), grid);
	if (dir === 'left' || dir === 'right') {
		let x = snap(anchor.x, grid);
		if (dir === 'right')
			x = Math.max(x, snapUp(bbox.maxX, grid) + gap);
		else
			x = Math.min(x, snapDown(bbox.minX, grid) - gap);
		return { wire: [px, py, x, py], label: { x, y: py } };
	}
	let y = snap(anchor.y, grid);
	if (dir === 'down')
		y = Math.max(y, snapUp(bbox.maxY, grid) + gap);
	else
		y = Math.min(y, snapDown(bbox.minY, grid) - gap);
	return { wire: [px, py, px, y], label: { x: px, y } };
}

/**
 * 导线折线（[x1,y1,...] 平坦数组或 [[x,y],...] 顶点数组，两种 API 返回形态）
 * 的全部顶点；判断"引脚是否已被导线连接"时逐顶点比对。
 */
export function wireVertices(line: number[] | Array<Array<number>> | undefined): Array<{ x: number; y: number }> {
	const pts: Array<{ x: number; y: number }> = [];
	if (!Array.isArray(line))
		return pts;
	if (typeof line[0] === 'number') {
		for (let i = 0; i + 1 < (line as number[]).length; i += 2)
			pts.push({ x: Number(line[i]), y: Number(line[i + 1]) });
	}
	else {
		for (const p of line as Array<Array<number>>)
			pts.push({ x: Number(p?.[0]), y: Number(p?.[1]) });
	}
	return pts.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}

/** 点是否贴合任一已有导线顶点（eps=1 容差，画布坐标整数） */
export function pointOnAnyWire(px: number, py: number, wirePoints: Array<{ x: number; y: number }>, eps = 1): boolean {
	for (const p of wirePoints) {
		if (Math.abs(p.x - px) <= eps && Math.abs(p.y - py) <= eps)
			return true;
	}
	return false;
}
