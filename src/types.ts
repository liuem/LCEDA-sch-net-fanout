/**
 * 公共类型与默认配置 / Types & default config
 *
 * 坐标单位：原理图画布 1 单位 = 0.01 英寸 = 10mil；
 * 默认网格 10 单位（0.1 英寸 = 100mil），引脚端点恒落在网格上。
 */

/** 网络名可见形式 */
export type LabelStyle = 'auto' | 'netlabel' | 'netport' | 'none';

/** 放置模式：direct=直接放在引脚上；follow=标签列锚定到鼠标位置 */
export type PlacementMode = 'direct' | 'follow';

export interface FanoutConfig {
	/** 忽略名单（逗号/分号/换行分隔，忽略大小写整词匹配，支持 * 通配） */
	ignoreList: string;
	/** 网络名前缀（便于后续按前缀搜索统一处理） */
	prefix: string;
	/** 网络名后缀 */
	suffix: string;
	/** 长引脚名分段分隔符（空=不分段），默认 "/" */
	separator: string;
	/** 取分隔后第几段（1 起；负数从尾部倒数；越界自动钳位），默认 1 */
	segmentIndex: number;
	/** 放置模式，默认 direct */
	placement: PlacementMode;
	/** 引出方向人工校正（自动判向对个别符号样式误判时的一键纠正），默认 none */
	dirCorrection: 'none' | 'swapLR' | 'swapUD' | 'rotate180';
	/** direct 模式引出导线长度（原理图单位，10=100mil），默认 30 */
	wireLength: number;
	/** 网络名可见形式：auto=v4 有 createNetLabel 就精确定位标签，否则用导线原生虚拟网络标签（全版本可用） */
	labelStyle: LabelStyle;
	/** 标签定位：auto=分侧对齐（右/下引出文字从线端向右，左/上引出文字在线端向左结束）；native=编辑器原生位置 */
	labelAlign: 'auto' | 'native';
	/** 跳过带"不连接(No ERC)"标记的引脚，默认开 */
	skipNoConnect: boolean;
	/** 网格（原理图单位），标签列与导线端点对齐到该网格，默认 10 */
	snapGrid: number;
	/** 相邻两次创建调用的间隔毫秒（画布事务限流：实测连发 12 次后批量失败），默认 100 */
	createIntervalMs: number;
	/** 单次创建失败后的最大重试次数（退避 200ms×次数），默认 3 */
	maxRetries: number;
}

/** 常见电源/地网络默认忽略名单（用户可在设置页增删） */
export const DEFAULT_IGNORE_LIST = [
	'VCC',
	'VDD',
	'VEE',
	'VSS',
	'GND',
	'AGND',
	'DGND',
	'PGND',
	'GNDA',
	'VBAT',
	'VBUS',
	'VIN',
	'VREF',
	'VDDA',
	'VSSA',
	'AVDD',
	'AVSS',
	'3V3',
	'5V',
	'+3V3',
	'+5V',
	'1V8',
	'2V5',
	'NC',
].join(',');

export const DEFAULT_CONFIG: FanoutConfig = {
	ignoreList: DEFAULT_IGNORE_LIST,
	prefix: '',
	suffix: '',
	separator: '/',
	segmentIndex: 1,
	placement: 'direct',
	dirCorrection: 'none',
	wireLength: 30,
	labelStyle: 'auto',
	labelAlign: 'auto',
	skipNoConnect: true,
	snapGrid: 10,
	createIntervalMs: 100,
	maxRetries: 3,
};

/** 器件引脚（画布绝对坐标） */
export interface SchPinInfo {
	pinNumber: string;
	pinName: string;
	x: number;
	y: number;
	/** 带"不连接(No ERC)"标记 */
	noConnect: boolean;
	/** 引脚旋转角（度，同侧引脚同值；朝向判定主判据，可缺省） */
	rotation?: number;
}

/** 选中器件 */
export interface SchCompInfo {
	primitiveId: string;
	designator: string;
	/** 引脚外接盒（绝对坐标） */
	bbox: { minX: number; minY: number; maxX: number; maxY: number };
	pins: SchPinInfo[];
}

/** 已有电气状态：用于判断"引脚当前没有网络" */
export interface ExistingState {
	/** 网表映射：`位号-引脚号` -> 网络名 */
	pinNets: Map<string, string>;
	/** 已有导线顶点（含端点），任一落在引脚上即视为已连接 */
	wirePoints: Array<{ x: number; y: number }>;
}

/** 4 方向 */
export type Dir4 = 'left' | 'right' | 'up' | 'down';

/** 单条扇出计划：引脚 -> 网络 + 承载导线 + 标签位置 */
export interface PlanItem {
	designator: string;
	pinNumber: string;
	pinName: string;
	net: string;
	dir: Dir4;
	/** 导线折线 [x1,y1,x2,y2,...]（原理图单位，起 点=引脚端点） */
	wire: number[];
	/** 标签锚点（导线末端） */
	label: { x: number; y: number };
}

export interface SkipItem {
	designator: string;
	pinNumber: string;
	pinName: string;
	reason: string;
}

export interface FanoutPlan {
	items: PlanItem[];
	skips: SkipItem[];
	/** 同名网络（多引脚共享，如多组 VDD 分段后同名）提示用 */
	duplicates: Array<{ net: string; count: number }>;
	/** follow 模式实际使用的锚点（列位置） */
	anchor?: { x: number; y: number };
}
