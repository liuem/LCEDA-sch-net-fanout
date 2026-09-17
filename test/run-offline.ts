/**
 * 离线测试 / Offline tests（不依赖 EDA 运行时，node 直接运行）
 *
 * 覆盖：引脚名分段/前后缀/忽略名单、Protel2 网表解析、引脚朝向判定
 * （四边 + 中心回退）、导线几何（直接引出/跟随鼠标钳位/网格吸附）、
 * 规划主流程（已有网络/已有导线/No ERC/无名引脚/同名网络统计）、
 * applyPlan 写回（成功/失败/标签回退/样式解析）、配置存取与清理。
 *
 * 用法：node test/run-offline.ts
 */
import type { ApplyHooks } from '../src/eda-adapter.ts';
import type { FanoutPlan } from '../src/types.ts';
import process from 'node:process';
import { AdaptivePacer, applyPlan, cleanupCreated, estimateNetWidth, labelAnchorX, loadConfig, resolveLabelStyle } from '../src/eda-adapter.ts';
import {
	directWire,
	followWire,
	outwardDirection,
	pointOnAnyWire,
	resolvePinDirections,
	snap,
	wireVertices,
} from '../src/geometry.ts';
import { parseProtel2Netlist } from '../src/netlist.ts';
import { deriveNetName, isPinIgnored, matchIgnore, parseIgnoreList, pickSegment } from '../src/pin-name.ts';
import { planNetFanout, planSummary } from '../src/planner.ts';
import { buildExisting, buildFixture, cfgOf } from './fixture.ts';

/* ---- 全局 eda mock（loadConfig/persistCreated 等经 sys_Storage 读写） ---- */
const storage = new Map<string, string>();
(globalThis as any).eda = {
	sys_Storage: {
		getExtensionUserConfig: (k: string) => storage.get(k),
		setExtensionUserConfig: async (k: string, v: string) => { storage.set(k, v); },
	},
};

let failures = 0;
let checks = 0;

function ok(cond: boolean, label: string, detail = ''): void {
	checks++;
	if (!cond) {
		failures++;
		console.error(`  ✗ ${label}${detail ? `：${detail}` : ''}`);
	}
}

function eq<T>(actual: T, expected: T, label: string): void {
	ok(actual === expected, label, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

function deepEq(actual: unknown, expected: unknown, label: string): void {
	ok(JSON.stringify(actual) === JSON.stringify(expected), label, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

/* ---------------- 1. 引脚名分段与网络名推导 ---------------- */

function testNameDerivation(): void {
	console.log('\n[1] 引脚名分段与网络名推导');
	eq(pickSegment('USART1_TX/PB6', '/', 2), 'PB6', '取第 2 段');
	eq(pickSegment('USART1_TX/PB6', '/', 1), 'USART1_TX', '取第 1 段');
	eq(pickSegment('USART1_TX/PB6', '/', -1), 'PB6', '取最后一段');
	eq(pickSegment('USART1_TX/PB6', '/', -2), 'USART1_TX', '倒数第 2 段');
	eq(pickSegment('USART1_TX/PB6', '/', 99), 'PB6', '越界钳到末段');
	eq(pickSegment('USART1_TX/PB6', '/', -99), 'USART1_TX', '越界钳到首段');
	eq(pickSegment('PA0', '/', 1), 'PA0', '无分隔符返回整体');
	eq(pickSegment('PA0', '', 2), 'PA0', '空分隔符返回整体');
	eq(pickSegment('A/B/C', '/', 2), 'B', '三段取中段');
	eq(pickSegment('  PA0  ', '/', 1), 'PA0', '去首尾空白');
	eq(pickSegment('PA 0', '/', 1), 'PA_0', '内部空白折叠为下划线');
	eq(pickSegment('VDD//1', '/', 1), 'VDD', '连续分隔符产生空段被过滤');

	const opts = { separator: '/', segmentIndex: 2, prefix: 'MCU_', suffix: '_N' };
	eq(deriveNetName('USART1_TX/PB6', opts), 'MCU_PB6_N', '前缀+分段+后缀');
	eq(deriveNetName('PB7/RX1', opts), 'MCU_RX1_N', '第二个分段名');
	eq(deriveNetName('PA0', opts), 'MCU_PA0_N', '无分隔符也加前后缀');
	eq(deriveNetName('', opts), 'MCU__N', '空名不炸（planner 侧已过滤无名引脚）');

	// 分隔符为多字符/正则元字符
	eq(pickSegment('A.B.C', '.', 2), 'B', '分隔符 . 按字面切分');
	eq(pickSegment('A::B', '::', 2), 'B', '多字符分隔符');
}

/* ---------------- 2. 忽略名单 ---------------- */

function testIgnore(): void {
	console.log('\n[2] 忽略名单');
	const pats = parseIgnoreList('VCC, gnd ;;3V3\n+3V3, USB*');
	eq(pats.length, 5, '逗号/分号/换行混合分隔');
	ok(pats.includes('VCC') && pats.includes('gnd') && pats.includes('USB*'), '去空白保留条目');

	eq(matchIgnore('VCC', pats), 'VCC', '整词命中');
	eq(matchIgnore('vcc', pats), 'VCC', '忽略大小写');
	eq(matchIgnore('+3V3', pats), '+3V3', '+ 开头网络名');
	eq(matchIgnore('USB_DP', pats), 'USB*', '* 通配命中');
	eq(matchIgnore('USB', pats), 'USB*', '通配匹配空串段');
	eq(matchIgnore('GND1', pats), undefined, '无通配时不做包含匹配');
	eq(matchIgnore('VCC1', pats), undefined, '整词不误伤 VCC1');
	eq(matchIgnore('', pats), undefined, '空名不命中');

	const opts = { separator: '/', segmentIndex: 1, prefix: '', suffix: '' };
	eq(isPinIgnored('VDD/1', ['VDD'], opts), 'VDD', '完整引脚名命中');
	const opts2 = { ...opts, segmentIndex: 2 };
	eq(isPinIgnored('PA0/VDD', ['VDD'], opts2), 'VDD', '分段基名命中（取段后是电源）');
	eq(isPinIgnored('VDD/PA0', ['VDD'], opts2), undefined, '首段电源但取末段信号 -> 不忽略');

	// 默认名单覆盖常见电源地
	const defaults = parseIgnoreList('VCC,VDD,VEE,VSS,GND,AGND,DGND,PGND,GNDA,VBAT,VBUS,VIN,VREF,VDDA,VSSA,AVDD,AVSS,3V3,5V,+3V3,+5V,1V8,2V5,NC');
	for (const n of ['VCC', 'VDD', 'GND', 'AGND', '3V3', '+5V', 'NC', 'VBAT'])
		ok(matchIgnore(n, defaults) !== undefined, `默认名单命中 ${n}`);
	for (const n of ['PA0', 'NRST', 'BOOT0', 'SWDIO'])
		ok(matchIgnore(n, defaults) === undefined, `默认名单不误伤 ${n}`);
}

/* ---------------- 3. Protel2 网表解析 ---------------- */

function testNetlist(): void {
	console.log('\n[3] Protel2 网表解析');
	const text = [
		'[',
		'U1',
		'LQFP64',
		'64',
		'',
		']',
		'(',
		'LED_NET',
		'1',
		'U1-8',
		')',
		'(',
		'"VCC 3V3"',
		'3',
		'U1-3',
		'U1-13',
		'U2-1',
		')',
		'(',
		'NetQ1_2',
		'1',
		'Q1-2',
		')',
	].join('\n');
	const map = parseProtel2Netlist(text);
	eq(map.size, 5, '5 个引脚入网');
	eq(map.get('U1-8'), 'LED_NET', 'U1-8 -> LED_NET');
	eq(map.get('U1-3'), 'VCC 3V3', '网络名两端引号被剥除');
	eq(map.get('U2-1'), 'VCC 3V3', '同名网络多引脚');
	eq(map.get('U1-64'), undefined, '未连接引脚不在网表');
	eq(parseProtel2Netlist('').size, 0, '空文本');
	eq(parseProtel2Netlist('garbage').size, 0, '脏文本不炸');
}

/* ---------------- 4. 几何：朝向 / 导线 / 顶点 ---------------- */

function testGeometry(): void {
	console.log('\n[4] 几何：朝向判定与导线生成');
	const bbox = { minX: 1000, minY: 1000, maxX: 1400, maxY: 1600 };
	eq(outwardDirection(1000, 1100, bbox), 'left', '左边缘引脚朝左');
	eq(outwardDirection(1000, 1300, bbox), 'left', '左边缘中点朝左');
	eq(outwardDirection(1400, 1100, bbox), 'right', '右边缘引脚朝右');
	eq(outwardDirection(1200, 1000, bbox), 'up', '顶边缘引脚朝上');
	eq(outwardDirection(1200, 1600, bbox), 'down', '底边缘引脚朝下');
	eq(outwardDirection(1200, 1300, bbox), 'right', '中心回退右');
	eq(outwardDirection(1100, 1200, bbox), 'left', '对角平分点（|dx|==|dy| 主轴 x）');
	eq(outwardDirection(1500, 1700, bbox), 'down', '右下角（|dy|>|dx|）');

	eq(snap(34, 10), 30, '吸附 34->30');
	eq(snap(35, 10), 40, '吸附 35->40');
	eq(snap(37, 0), 37, '网格 0 不吸附');

	deepEq(directWire(1000, 1100, 'left', 30, 10).wire, [1000, 1100, 970, 1100], '左引出 30');
	deepEq(directWire(1400, 1100, 'right', 30, 10).wire, [1400, 1100, 1430, 1100], '右引出 30');
	deepEq(directWire(1200, 1000, 'up', 30, 10).wire, [1200, 1000, 1200, 970], '上引出 30');
	deepEq(directWire(1200, 1600, 'down', 30, 10).wire, [1200, 1600, 1200, 1630], '下引出 30');
	deepEq(directWire(1000, 1100, 'left', 35, 10).wire, [1000, 1100, 960, 1100], '长度吸附网格（35->40）');
	deepEq(directWire(1000, 1100, 'left', 5, 10).wire, [1000, 1100, 990, 1100], '最小 1 格');
	const dw = directWire(1000, 1100, 'left', 30, 10);
	deepEq(dw.label, { x: 970, y: 1100 }, '标签在导线末端');

	// follow：左引脚 -> 鼠标竖列
	deepEq(followWire(1000, 1100, 'left', { x: 800, y: 900 }, bbox, 10).wire, [1000, 1100, 800, 1100], '左引脚引到鼠标列');
	deepEq(followWire(1000, 1100, 'left', { x: 800, y: 900 }, bbox, 10).label, { x: 800, y: 1100 }, '标签在列上（y=引脚 y）');
	// 鼠标列在器件内部 -> 钳位到器件外至少 minLen（默认 3 格，防短桩）
	deepEq(followWire(1000, 1100, 'left', { x: 1200, y: 900 }, bbox, 10).wire, [1000, 1100, 970, 1100], '左引脚锚点钳位（默认 3 格）');
	deepEq(followWire(1400, 1100, 'right', { x: 1200, y: 900 }, bbox, 10).wire, [1400, 1100, 1430, 1100], '右引脚锚点钳位（默认 3 格）');
	deepEq(followWire(1200, 1000, 'up', { x: 900, y: 1300 }, bbox, 10).wire, [1200, 1000, 1200, 970], '上引脚锚点钳位（默认 3 格）');
	deepEq(followWire(1200, 1600, 'down', { x: 900, y: 1300 }, bbox, 10).wire, [1200, 1600, 1200, 1630], '下引脚锚点钳位（默认 3 格）');
	// 显式 minLen：实测回归（API 盒 235..570 缩在引脚 205/595 以内，锚点在器件内）。
	// 钳位边界取"盒 ∪ 引脚点云"，不再产出 5 单位短桩
	const ubox = { minX: 205, minY: 200, maxX: 595, maxY: 880 };
	deepEq(followWire(205, 845, 'left', { x: 600, y: 1482 }, ubox, 10, 30).wire, [205, 845, 170, 845], '左引脚锚点在器件内（minLen=30，端点 170）');
	deepEq(followWire(595, 210, 'right', { x: 600, y: 1482 }, ubox, 10, 30).wire, [595, 210, 630, 210], '右引脚锚点贴边（minLen=30，端点 630）');
	// 锚点吸附网格（非整格鼠标位置）
	deepEq(followWire(1000, 1100, 'left', { x: 807, y: 903 }, bbox, 10).wire, [1000, 1100, 810, 1100], '锚点吸附网格 807->810');

	deepEq(wireVertices([10, 20, 30, 40]), [{ x: 10, y: 20 }, { x: 30, y: 40 }], '平坦数组顶点');
	deepEq(wireVertices([[10, 20], [30, 40], [50, 60]]), [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }], '顶点数组');
	eq(wireVertices(undefined).length, 0, 'undefined 导线');

	ok(pointOnAnyWire(1400, 1200, [{ x: 1400, y: 1200 }]), '端点贴合');
	ok(pointOnAnyWire(1400.5, 1200.5, [{ x: 1400, y: 1200 }]), 'eps=1 内贴合');
	ok(!pointOnAnyWire(1402, 1200, [{ x: 1400, y: 1200 }]), '超出 eps');
}

/* ---------------- 4b. 实测回归：Spartan7 引脚场朝向 + 斜线修复 ---------------- */

function testSpartanRegression(): void {
	console.log('\n[4b] 实测回归（Spartan7 真实坐标：v0.1.0 方向误判与斜线）');
	// 摘自实测明细：左列引脚 x=205（y 205..845）、右列 x=595，
	// v0.1.0 按外接盒中心主轴把左列上部引脚误判为上向、下部误判为下向
	const leftYs = [785, 725, 715, 705, 695, 685, 605, 595, 585, 575, 565, 555, 545, 535, 525, 455, 445, 435, 425, 355, 345, 335, 325, 315, 305, 275, 265, 215, 205];
	const rightYs = [210, 220, 230, 240, 250, 260, 270, 280, 290, 300];
	const pins = [
		...leftYs.map(y => ({ x: 205, y })),
		...rightYs.map(y => ({ x: 595, y })),
	];
	const bbox = { minX: 205, minY: 205, maxX: 595, maxY: 845 };
	const dirs = resolvePinDirections(pins, bbox);
	eq(dirs.length, pins.length, '朝向数与引脚数一致');
	ok(dirs.slice(0, leftYs.length).every(d => d === 'left'), '左列全部 29 脚朝左（含旧版误判的上/下向引脚）');
	ok(dirs.slice(leftYs.length).every(d => d === 'right'), '右列全部 10 脚朝右');

	// v0.1.0 明细里的三个实际误判样本：现在必须朝左/朝右
	const dirsByY = new Map(leftYs.map((y, i) => [y, dirs[i]]));
	eq(dirsByY.get(425), 'left', '(205,425) 左列上部 -> 左（旧版误判上）');
	eq(dirsByY.get(205), 'left', '(205,205) 左列最上角点 -> 左（多数派消歧）');
	eq(dirs[dirs.length - 1], 'right', '(595,300) 右列 -> 右（旧版误判上）');

	// 斜线修复：引脚在 5 偏移网格（205/785），导线必须水平/垂直
	deepEq(directWire(205, 785, 'left', 30, 10).wire, [205, 785, 180, 785], '左引出保持 y=785（旧版产出 790 斜线）');
	deepEq(directWire(205, 785, 'left', 30, 10).label, { x: 180, y: 785 }, '标签随导线末端');
	deepEq(directWire(595, 210, 'right', 30, 10).wire, [595, 210, 630, 210], '右引出保持 y=210（终点吸附 595+30=625->630）');
	deepEq(directWire(205, 845, 'down', 30, 10).wire, [205, 845, 205, 880], '下引出保持 x=205（845+30=875->880）');

	// 连接器类单列点云：整体按器件中心定侧
	const singleCol = [{ x: 200, y: 100 }, { x: 200, y: 200 }, { x: 200, y: 300 }];
	deepEq(resolvePinDirections(singleCol, { minX: 190, minY: 90, maxX: 400, maxY: 310 }), ['left', 'left', 'left'], '单列引脚整体朝左（本体在右）');
	const noInfo = resolvePinDirections(singleCol, { minX: 190, minY: 90, maxX: 210, maxY: 310 });
	ok(noInfo.length === 3 && noInfo.every(d => d === noInfo[0]), '无器件信息兜底不炸且方向一致');
	const singleRow = [{ x: 100, y: 200 }, { x: 200, y: 200 }, { x: 300, y: 200 }];
	deepEq(resolvePinDirections(singleRow, { minX: 90, minY: 190, maxX: 310, maxY: 400 }), ['up', 'up', 'up'], '单行引脚整体朝上（本体在下）');

	// 内部引脚（不在任何边缘）：兜底主轴
	const inner = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 1000 }, { x: 1000, y: 1000 }, { x: 600, y: 400 }];
	const innerDirs = resolvePinDirections(inner, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
	eq(innerDirs[4], 'right', '场内引脚兜底主轴');

	// 全流程回归：Spartan 场景走 planner（朝向 + 正交导线）
	const comp: import('../src/types.ts').SchCompInfo = {
		primitiveId: 'u1',
		designator: 'U1',
		bbox,
		pins: pins.slice(0, 5).map((p, i) => ({ pinNumber: String(i + 1), pinName: `IO_${i}_14`, x: p.x, y: p.y, noConnect: false })),
	};
	const plan = planNetFanout([comp], { pinNets: new Map(), wirePoints: [] }, cfgOf());
	const expectYs = [785, 725, 715, 705, 695];
	for (const it of plan.items) {
		const [x1, y1, x2, y2] = it.wire;
		ok(y1 === y2 || x1 === x2, `${it.pinName} 导线正交`, `[${it.wire}]`);
		eq(it.dir, 'left', `${it.pinName} 朝左`);
		ok(it.wire[0] === 205 && it.wire[1] === expectYs[Number(it.pinNumber) - 1], `${it.pinName} 起点=引脚端点`);
	}
}

/* ---------------- 4c. rotation 判向 / 方向人工校正 ---------------- */

function testRotationDirections(): void {
	console.log('\n[4c] rotation 分组判向与人工校正');
	// rotation 主判据：同侧引脚同 rotation；组质心相对整体中心定侧。
	// 参差列（左列两档 x=205/215）点云边缘法失效，rotation 分组不受影响
	const staggered = [
		{ x: 205, y: 700, rotation: 180 },
		{ x: 215, y: 650, rotation: 180 },
		{ x: 205, y: 600, rotation: 180 },
		{ x: 215, y: 550, rotation: 180 },
		{ x: 595, y: 700, rotation: 0 },
		{ x: 585, y: 650, rotation: 0 },
		{ x: 595, y: 600, rotation: 0 },
		{ x: 585, y: 550, rotation: 0 },
	];
	const dirs = resolvePinDirections(staggered, { minX: 205, minY: 550, maxX: 595, maxY: 700 });
	ok(dirs.slice(0, 4).every(d => d === 'left'), '参差左列全部朝左（rotation 分组）');
	ok(dirs.slice(4).every(d => d === 'right'), '参差右列全部朝右');

	// 个别引脚 rotation 画错：跟随其 rotation 组（符号作者意图优先，位置法只作无 rotation 时的兜底）
	const mixed = [
		{ x: 205, y: 600, rotation: 180 },
		{ x: 205, y: 550, rotation: 180 },
		{ x: 205, y: 500, rotation: 0 }, // 画错的左引脚（rotation 与右列同组）
		{ x: 595, y: 600, rotation: 0 },
		{ x: 595, y: 550, rotation: 0 },
	];
	const dirs2 = resolvePinDirections(mixed, { minX: 205, minY: 500, maxX: 595, maxY: 600 });
	eq(dirs2[0], 'left', '正常左引脚跟随 rotation 组');
	eq(dirs2[2], 'right', '画错的 rotation 跟随组方向（组优先）');
	eq(dirs2[3], 'right', '正常右引脚跟随 rotation 组');

	// 无 rotation（undefined）：退回点云边缘法（贴边引脚可靠，参差列本就无解）
	const noRot = staggered.map(({ x, y }) => ({ x, y }));
	const dirs3 = resolvePinDirections(noRot, { minX: 205, minY: 550, maxX: 595, maxY: 700 });
	eq(dirs3[0], 'left', '无 rotation：贴左缘引脚仍左');
	eq(dirs3[2], 'left', '无 rotation：贴左缘引脚仍左');
	eq(dirs3[4], 'right', '无 rotation：贴右缘引脚仍右');

	// 人工校正开关（planner 层）
	const comp: import('../src/types.ts').SchCompInfo = {
		primitiveId: 'u9',
		designator: 'U9',
		bbox: { minX: 1000, minY: 1000, maxX: 1400, maxY: 1600 },
		pins: [
			{ pinNumber: '1', pinName: 'PA0', x: 1000, y: 1100, noConnect: false },
			{ pinNumber: '2', pinName: 'PB0', x: 1400, y: 1100, noConnect: false },
			{ pinNumber: '3', pinName: 'PH0', x: 1200, y: 1000, noConnect: false },
		],
	};
	const p = planNetFanout([comp], { pinNets: new Map(), wirePoints: [] }, cfgOf());
	eq(p.items.find(it => it.net === 'PA0')?.dir, 'left', '默认自动判向 PA0 左');
	eq(p.items.find(it => it.net === 'PB0')?.dir, 'right', '默认自动判向 PB0 右');
	eq(p.items.find(it => it.net === 'PH0')?.dir, 'up', '默认自动判向 PH0 上');
	const p2 = planNetFanout([comp], { pinNets: new Map(), wirePoints: [] }, cfgOf({ dirCorrection: 'swapLR' }));
	eq(p2.items.find(it => it.net === 'PA0')?.dir, 'right', '左右互换后 PA0 右');
	eq(p2.items.find(it => it.net === 'PB0')?.dir, 'left', '左右互换后 PB0 左');
	eq(p2.items.find(it => it.net === 'PH0')?.dir, 'up', '左右互换不影响上下');
	const p3 = planNetFanout([comp], { pinNets: new Map(), wirePoints: [] }, cfgOf({ dirCorrection: 'rotate180' }));
	eq(p3.items.find(it => it.net === 'PH0')?.dir, 'down', '旋转 180° 后 PH0 下');
	deepEq(p2.items.find(it => it.net === 'PA0')?.wire, [1000, 1100, 1030, 1100], '校正后导线沿新方向且保持正交');
}

/* ---------------- 5. 规划主流程 ---------------- */

function planOf(cfg = cfgOf(), anchor?: { x: number; y: number }): FanoutPlan {
	return planNetFanout(buildFixture(), buildExisting(), cfg, anchor);
}

function testPlanner(): void {
	console.log('\n[5] 规划主流程（默认：分隔符 / 取第 1 段，电源地名单忽略）');
	const plan = planOf();

	const created = (num: string) => plan.items.find(it => it.designator === 'U1' && it.pinNumber === num);
	const skipped = (num: string) => plan.skips.find(s => s.designator === 'U1' && s.pinNumber === num);

	// 创建项：未连网络、未忽略、无 No ERC
	eq(created('1')?.net, 'PA0', 'PA0 创建');
	eq(created('11')?.net, 'PB0', 'PB0 创建');
	eq(created('21')?.net, 'PH0', '顶边 PH0 创建');
	eq(created('31')?.net, 'BOOT0', '底边 BOOT0 创建');
	eq(created('4')?.net, 'USART1_TX', '默认取第 1 段');
	eq(created('14')?.net, 'PB7', '默认取第 1 段（PB7/RX1）');
	eq(created('7')?.net, '7', '无名引脚用引脚号命名');

	// 朝向
	eq(created('1')?.dir, 'left', '左引脚朝左');
	eq(created('11')?.dir, 'right', '右引脚朝右');
	eq(created('21')?.dir, 'up', '顶引脚朝上');
	eq(created('31')?.dir, 'down', '底引脚朝下');

	// 导线起点恒为引脚端点（保证电气连接）
	deepEq(created('1')?.wire.slice(0, 2), [1000, 1100], '导线起点=引脚端点');
	deepEq(created('1')?.wire, [1000, 1100, 970, 1100], 'PA0 导线形状（短名 3 字符不延长）');
	deepEq(created('1')?.label, { x: 970, y: 1100 }, 'PA0 标签位置');
	// 左引出长网络名：导线延长到覆盖文字宽度（USART1_TX 9 字符 -> 63+2 -> 70 单位）
	deepEq(created('4')?.wire, [1000, 1400, 930, 1400], '长名左引出导线延长（30 -> 70）');
	deepEq(created('4')?.label, { x: 930, y: 1400 }, '长名标签锚在外端（文字压线抵引脚）');
	// 右引出不延长（文字向线外延伸，锚点在线上即可）
	deepEq(created('11')?.wire, [1400, 1100, 1430, 1100], '右引出导线不延长');
	// 顶引出短名不延长
	deepEq(created('21')?.wire, [1200, 1000, 1200, 970], '顶引出 PH0 长度 30（3 字符不需延长）');

	// 跳过项
	ok(skipped('3')?.reason.includes('忽略名单'), 'VDD/1 首段电源被忽略');
	ok(skipped('5')?.reason.includes('忽略名单'), 'NC 被忽略');
	ok(skipped('13')?.reason.includes('忽略名单'), 'VSS 被忽略');
	ok(skipped('6')?.reason.includes('No ERC'), 'No ERC 引脚跳过');
	ok(skipped('8')?.reason.includes('LED_NET'), '网表已有网络跳过');
	ok(skipped('12')?.reason.includes('导线'), '已有导线连接跳过');

	// U2 正常
	ok(plan.items.some(it => it.designator === 'U2' && it.net === 'EN'), 'U2 EN 创建');
	ok(plan.items.some(it => it.designator === 'U2' && it.net === 'SW'), 'U2 SW 创建');

	// 同名网络：U1-1 与 U1-6 都叫 PA0，但 U1-6 被 No ERC 跳过 -> 默认无重复
	eq(plan.duplicates.length, 0, '默认无同名网络');

	console.log('\n[5b] 取末段 + 前后缀');
	const plan2 = planOf(cfgOf({ separator: '/', segmentIndex: 2, prefix: 'MCU_', suffix: '_N' }));
	const created2 = (num: string) => plan2.items.find(it => it.designator === 'U1' && it.pinNumber === num);
	eq(created2('4')?.net, 'MCU_PB6_N', '取末段 PB6 + 前后缀');
	eq(created2('14')?.net, 'MCU_RX1_N', '取末段 RX1 + 前后缀');
	// VDD/1 取末段 "1" 不再命中电源名单；但 PA2(脚8) 已在网络表 -> VDD/1 创建名为 1
	eq(created2('3')?.net, 'MCU_1_N', '电源段被取走后不再忽略（脚名首段 VDD 未参与匹配取段=2 时）');
	ok(plan2.skips.find(s => s.designator === 'U1' && s.pinNumber === '8')?.reason.includes('LED_NET'), '网络表跳过仍生效');

	console.log('\n[5c] No ERC 不跳过');
	const plan3 = planOf(cfgOf({ skipNoConnect: false }));
	ok(plan3.items.some(it => it.pinNumber === '6' && it.net === 'PA0'), 'No ERC 引脚参与创建');
	eq(plan3.duplicates[0]?.net, 'PA0', '两个 PA0 同名网络被统计');
	eq(plan3.duplicates[0]?.count, 2, 'PA0 重复 2 次');

	console.log('\n[5d] 跟随鼠标');
	const plan4 = planOf(cfgOf({ placement: 'follow' }), { x: 700, y: 2000 });
	const item = plan4.items.find(it => it.pinNumber === '1');
	deepEq(item?.wire, [1000, 1100, 700, 1100], '左引脚引到鼠标列 700');
	deepEq(item?.label, { x: 700, y: 1100 }, '标签在鼠标列上对齐');
	const itemR = plan4.items.find(it => it.pinNumber === '11');
	ok((itemR?.wire[2] ?? 0) >= 1410, '右引脚钳位到器件右外侧');
	deepEq(plan4.anchor, { x: 700, y: 2000 }, '锚点回传');
	// U2 不受 U1 锚点影响：锚点在 U2 bbox 内则各自钳位（最小引出=minLen）
	const plan5 = planNetFanout([buildFixture()[1]], { pinNets: new Map(), wirePoints: [] }, cfgOf({ placement: 'follow' }), { x: 100, y: 100 });
	deepEq(plan5.items.find(it => it.net === 'EN')?.wire, [0, 100, -30, 100], 'U2 左引脚钳位到自身外 minLen');
	deepEq(plan5.items.find(it => it.net === 'SW')?.wire, [200, 100, 230, 100], 'U2 右引脚钳位到自身外 minLen');

	console.log('\n[5e] 汇总文本');
	const summary = planSummary(plan, cfgOf());
	ok(summary.includes('创建网络') && summary.includes('跳过'), '汇总包含计数');
	ok(summary.includes('取第 1 段'), '汇总包含名称规则');
}

/* ---------------- 6. 写回（mock hooks） ---------------- */

interface MockCall {
	kind: 'wire' | 'label' | 'port';
	net: string;
}

function mockHooks(opts: { failWires?: string[]; failLabels?: boolean; failPorts?: boolean; supportsLabel?: boolean } = {}) {
	const calls: MockCall[] = [];
	const deleted = { wires: [] as string[], components: [] as string[] };
	let seq = 0;
	const hooks: ApplyHooks = {
		async createWire(line, net) {
			if (opts.failWires?.includes(net)) {
				return undefined;
			}
			calls.push({ kind: 'wire', net });
			return `wire-${++seq}`;
		},
		async createNetLabel(_x, _y, net) {
			if (opts.failLabels)
				return undefined;
			calls.push({ kind: 'label', net });
			return `label-${++seq}`;
		},
		async createNetPort(net) {
			if (opts.failPorts)
				return undefined;
			calls.push({ kind: 'port', net });
			return `port-${++seq}`;
		},
		supportsNetLabel() {
			return opts.supportsLabel ?? true;
		},
		async deleteWires(ids) {
			deleted.wires.push(...ids);
			return true;
		},
		async deleteComponents(ids) {
			deleted.components.push(...ids);
			return true;
		},
	};
	return { hooks, calls, deleted };
}

async function testApply(): Promise<void> {
	console.log('\n[6] 写回与样式回退');
	const plan = planOf(cfgOf({ separator: '/', segmentIndex: 2 })); // PA0/PB0/PB6/RX1...

	// 全成功 + 网络标签
	const m1 = mockHooks();
	const r1 = await applyPlan(plan, cfgOf(), m1.hooks);
	eq(r1.applied, plan.items.length, '全部创建成功');
	eq(r1.failed, 0, '无失败');
	eq(r1.labelFailed, 0, '标签全部成功');
	ok(m1.calls.every(c => c.kind === 'wire' || c.kind === 'label'), '只用导线+标签');
	eq(m1.calls.filter(c => c.kind === 'label').length, plan.items.length, '每个网络一个标签');
	eq(m1.calls.find(c => c.net === 'PB6')?.kind, 'wire', 'PB6 网络创建（取段生效）');
	ok(m1.calls.some(c => c.kind === 'label' && c.net === 'PB6'), 'PB6 标签创建');

	// 客户端不支持网络标签（V3.2 无 createNetLabel）-> auto 用导线原生虚拟网络标签
	const m2 = mockHooks({ supportsLabel: false });
	const r2 = await applyPlan(plan, cfgOf(), m2.hooks);
	eq(r2.applied, plan.items.length, 'v3 原生网络名仍全部成功');
	eq(m2.calls.filter(c => c.kind === 'wire').length, plan.items.length, '导线全部创建（携带网络名）');
	eq(m2.calls.filter(c => c.kind !== 'wire').length, 0, '不再创建任何标签/端口');

	// 显式 netport
	const m3 = mockHooks();
	await applyPlan(plan, cfgOf({ labelStyle: 'netport' }), m3.hooks);
	eq(m3.calls.filter(c => c.kind === 'port').length, plan.items.length, '显式端口样式');

	// 显式 none：仅导线
	const m4 = mockHooks();
	await applyPlan(plan, cfgOf({ labelStyle: 'none' }), m4.hooks);
	eq(m4.calls.filter(c => c.kind !== 'wire').length, 0, 'none 只创建导线');

	// 导线失败 -> 该项计失败，不放标签
	const target = plan.items[0].net;
	const m5 = mockHooks({ failWires: [target] });
	const r5 = await applyPlan(plan, cfgOf({ createIntervalMs: 0, maxRetries: 1 }), m5.hooks);
	eq(r5.failed, 1, '导线失败计 1');
	eq(r5.applied, plan.items.length - 1, '其余成功');
	ok(!m5.calls.some(c => c.kind === 'label' && c.net === target), '失败项不放标签');
	eq(r5.failedItems.length, 1, '失败明细记录');
	ok(r5.failedItems[0].includes(target), '失败明细含网络名');
	eq(r5.labelAborted, false, '正常路径不熔断');

	// 熔断：网络端口连续失败 5 次后停试（V3.2.149 createNetPort 全灭场景）
	const m5c = mockHooks({ failPorts: true });
	const r5c = await applyPlan(plan, cfgOf({ labelStyle: 'netport', createIntervalMs: 0 }), m5c.hooks);
	eq(r5c.applied, plan.items.length, '导线不受端口熔断影响');
	eq(r5c.labelFailed, 5, '端口恰好尝试 5 次后熔断');
	eq(r5c.labelAborted, true, '熔断标志置位');
	eq(r5c.createdPortIds.length, 0, '端口 ID 不记录');

	// 限流场景：createWire 前 2 次返回 undefined（模拟画布事务限流），第 3 次成功 -> 重试兜住
	const m5b = (() => {
		const calls: MockCall[] = [];
		const failCount = new Map<string, number>();
		const hooks: ApplyHooks = {
			async createWire(_line, net) {
				const n = (failCount.get(net) ?? 0) + 1;
				failCount.set(net, n);
				if (n <= 2)
					return undefined; // 前两次被限流
				calls.push({ kind: 'wire', net });
				return `wire-${net}`;
			},
			async createNetLabel(_x, _y, net) {
				calls.push({ kind: 'label', net });
				return `label-${net}`;
			},
			async createNetPort() {
				return undefined;
			},
			async deleteWires() {
				return true;
			},
			async deleteComponents() {
				return true;
			},
		};
		return { hooks, calls };
	})();
	const r5b = await applyPlan(planOf(), cfgOf({ createIntervalMs: 0 }), m5b.hooks);
	eq(r5b.failed, 0, '限流重试后全部成功');
	eq(r5b.applied, planOf().items.length, '重试兜住限流');

	// 标签失败 -> 熔断（连续 5 次）后跳过余下标签，导线保留（已带网络名）
	const m6 = mockHooks({ failLabels: true });
	const r6 = await applyPlan(plan, cfgOf({ createIntervalMs: 0 }), m6.hooks);
	eq(r6.applied, plan.items.length, '标签失败不影响导线');
	eq(r6.labelFailed, 5, '标签恰好在第 5 次失败后熔断');
	eq(r6.labelAborted, true, '标签熔断置位');

	// 样式解析
	eq(resolveLabelStyle(cfgOf(), mockHooks().hooks), 'netlabel', 'auto+支持 -> 标签');
	eq(resolveLabelStyle(cfgOf(), mockHooks({ supportsLabel: false }).hooks), 'none', 'auto+不支持 -> 导线原生网络名');
	eq(resolveLabelStyle(cfgOf({ labelStyle: 'none' }), mockHooks().hooks), 'none', '显式 none');
	eq(resolveLabelStyle(cfgOf({ labelStyle: 'netport' }), mockHooks({ supportsLabel: false }).hooks), 'netport', '显式端口不回退');
	eq(resolveLabelStyle(cfgOf({ labelStyle: 'netlabel' }), mockHooks({ supportsLabel: false }).hooks), 'netlabel', '显式标签不回退');

	// 自适应节奏：失败翻倍、封顶、连续成功回落
	const pacer = new AdaptivePacer(100);
	eq(pacer.current(), 100, '起步 100ms');
	eq(pacer.onFail(), 200, '失败翻倍 200');
	eq(pacer.onFail(), 400, '再失败 400');
	eq(pacer.onFail(), 800, '再失败 800');
	eq(pacer.onFail(), 1200, '封顶 1200');
	eq(pacer.onFail(), 1200, '维持封顶');
	for (let k = 0; k < 4; k++) pacer.onSuccess();
	eq(pacer.current(), 840, '连续 4 成功回落 30%');
	for (let k = 0; k < 4; k++) pacer.onSuccess();
	eq(pacer.current(), 588, '继续回落');
	const pacer0 = new AdaptivePacer(0);
	eq(pacer0.current(), 0, '起步 0 = 不限速');
	eq(pacer0.onFail(), 200, '0 起步失败后从 200 开始');
	pacer0.onSuccess();
	eq(pacer0.current(), 200, '单次成功不回落');

	// 分侧标签锚点：右/下=线端向外；左/上=线端减文字宽（文字向外结束）
	eq(estimateNetWidth('PA0'), 21, '3 字符估宽 21');
	ok(estimateNetWidth('IO_L8P_T1_AD3P_15') === 17 * 7, '17 字符估宽 119');
	eq(labelAnchorX('right', 595, 630), 595, '右引出锚点=导线起点(引脚端)，文字向右延伸');
	eq(labelAnchorX('down', 845, 880), 845, '下引出锚点=导线起点');
	eq(labelAnchorX('left', 205, 84), 84, '左引出锚点=导线外端（文字压线向右延伸至引脚）');
	eq(labelAnchorX('up', 1000, 970), 970, '上引出锚点=导线外端');

	// 原生模式（v3.2 auto/none）下的标签移动：auto 定位调用 repositionWireLabel，native 不调用
	const m8 = mockHooks({ supportsLabel: false });
	m8.hooks.repositionWireLabel = async (wireId, net, x) => {
		m8.calls.push({ kind: 'label', net: `${net}@${x}#${wireId}` });
		return true;
	};
	const plan8 = planOf();
	await applyPlan(plan8, cfgOf({ createIntervalMs: 0 }), m8.hooks);
	const moves = m8.calls.filter(c => c.kind === 'label' && c.net.includes('@'));
	eq(moves.length, plan8.items.length, '每个导线都请求移动标签');
	ok(moves.some(m => m.net.startsWith('PA0@970#')), '左引出 PA0 锚点=导线外端 970（文字压线延伸至引脚）');
	ok(moves.some(m => m.net.startsWith('PB0@1400#')), '右引出 PB0 锚点=导线起点 1400（文字向右延伸）');
	const m9 = mockHooks({ supportsLabel: false });
	let repositionCalled = false;
	m9.hooks.repositionWireLabel = async () => {
		repositionCalled = true;
		return true;
	};
	await applyPlan(plan8, cfgOf({ createIntervalMs: 0, labelAlign: 'native' }), m9.hooks);
	eq(repositionCalled, false, 'native 定位不移动标签');

	// 清理（隔离：先清空创建记录，再用一轮创建验证清理闭环）
	storage.delete('schNetFanoutCreatedIds');
	const m7 = mockHooks();
	const plan7 = planOf();
	const r7 = await applyPlan(plan7, cfgOf(), m7.hooks);
	const cleaned = await cleanupCreated(m7.hooks);
	eq(cleaned.wires, r7.createdWireIds.length, '清理导线数一致');
	eq(cleaned.ports, 0, '标签形式无端口记录');
	ok(m7.deleted.wires.length >= r7.createdWireIds.length, '删除调用包含创建的导线');
	// 再清理：无记录
	const again = await cleanupCreated(m7.hooks);
	eq(again.wires, 0, '重复清理无记录');
}

/* ---------------- 7. 配置存取 ---------------- */

function testConfig(): void {
	console.log('\n[7] 配置存取与钳位');
	const cfg = loadConfig();
	eq(cfg.placement, 'direct', '默认直接放置');
	eq(cfg.separator, '/', '默认分隔符');
	eq(cfg.segmentIndex, 1, '默认第 1 段');
	eq(cfg.labelStyle, 'auto', '默认 auto 标签');
	ok(cfg.ignoreList.includes('GND') && cfg.ignoreList.includes('VCC'), '默认忽略名单含电源地');

	// 脏数据钳位
	storage.set('schNetFanoutConfig', JSON.stringify({ placement: 'xxx', labelStyle: 'bad', segmentIndex: 0, wireLength: -5, snapGrid: 0, createIntervalMs: -1, maxRetries: -3, dirCorrection: 'bad' }));
	const bad = loadConfig();
	eq(bad.placement, 'direct', '非法放置钳位 direct');
	eq(bad.labelStyle, 'auto', '非法标签样式钳位 auto');
	eq(bad.dirCorrection, 'none', '非法方向校正钳位 none');
	eq(bad.segmentIndex, 1, '段号 0 钳位 1');
	eq(bad.wireLength, 30, '非法长度钳位 30');
	eq(bad.snapGrid, 10, '非法网格钳位 10');
	eq(bad.createIntervalMs, 100, '非法间隔钳位 100');
	eq(bad.maxRetries, 3, '非法重试钳位 3');
}

/* ---------------- 主入口 ---------------- */

(async () => {
	console.log('离线测试 lceda-sch-net-fanout');
	testNameDerivation();
	testIgnore();
	testNetlist();
	testGeometry();
	testSpartanRegression();
	testRotationDirections();
	testPlanner();
	await testApply();
	testConfig();

	console.log(`\n结果：${checks} 项断言，${failures} 失败`);
	if (failures)
		process.exit(1);
})();
