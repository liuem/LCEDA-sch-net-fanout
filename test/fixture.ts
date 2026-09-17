/**
 * 测试夹具：模拟多引脚器件（类 MCU）与已有电气状态
 */
import type { ExistingState, FanoutConfig, SchCompInfo } from '../src/types.ts';
import { DEFAULT_CONFIG } from '../src/types.ts';

/** U1：类 MCU，外接盒 (1000,1000)-(1400,1600)，四边都有引脚；U2：小器件 */
export function buildFixture(): SchCompInfo[] {
	const U1 = (num: string, name: string, x: number, y: number, noConnect = false) => ({
		pinNumber: num,
		pinName: name,
		x,
		y,
		noConnect,
	});
	return [
		{
			primitiveId: 'comp-u1',
			designator: 'U1',
			bbox: { minX: 1000, minY: 1000, maxX: 1400, maxY: 1600 },
			pins: [
				// 左边（朝左）
				U1('1', 'PA0', 1000, 1100),
				U1('2', 'PA1', 1000, 1200),
				U1('3', 'VDD/1', 1000, 1300), // 电源段在首段
				U1('4', 'USART1_TX/PB6', 1000, 1400), // 信号段在末段
				U1('5', 'NC', 1000, 1500),
				U1('6', 'PA0', 1000, 1550, true), // No ERC 标记
				U1('7', '', 1000, 1580), // 无名称，用引脚号
				// 右边（朝右）
				U1('11', 'PB0', 1400, 1100),
				U1('12', 'PB1', 1400, 1200), // 已有导线连接
				U1('13', 'VSS', 1400, 1300),
				U1('14', 'PB7/RX1', 1400, 1400), // 取末段 RX1
				// 顶边（朝上）
				U1('21', 'PH0', 1200, 1000),
				// 底边（朝下）
				U1('31', 'BOOT0', 1200, 1600),
				// 已在网络表（PA0 已连 LED_NET）
				U1('8', 'PA2', 1000, 1250),
			],
		},
		{
			primitiveId: 'comp-u2',
			designator: 'U2',
			bbox: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
			pins: [
				U1('1', 'EN', 0, 100),
				U1('2', 'SW', 200, 100),
			],
		},
	];
}

/** 已有状态：U1-8(PA2) 在网表中；PB1(1400,1200) 被导线端点连接 */
export function buildExisting(): ExistingState {
	return {
		pinNets: new Map([['U1-8', 'LED_NET']]),
		wirePoints: [{ x: 1400, y: 1200 }],
	};
}

export function cfgOf(over: Partial<FanoutConfig> = {}): FanoutConfig {
	return { ...DEFAULT_CONFIG, ...over };
}
