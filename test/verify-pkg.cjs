const fs = require('node:fs');
const process = require('node:process');
const JSZip = require('jszip');

const pkg = process.argv[2] || 'build/dist/lceda-sch-net-fanout_v0.1.7.eext';
JSZip.loadAsync(fs.readFileSync(pkg)).then(async (z) => {
	const names = Object.keys(z.files).filter(n => !z.files[n].dir);
	console.log('包内文件:');
	names.forEach(n => console.log(' -', n));
	if (!names.includes('iframe/settings.html'))
		throw new Error('缺少 iframe/settings.html（设置面板）');
	if (!names.some(n => n.startsWith('images/')))
		throw new Error('缺少 images/（logo 与 banner）');
	const cfg = JSON.parse(await z.file('extension.json').async('string'));
	console.log('版本:', cfg.version, '| 菜单环境:', Object.keys(cfg.headerMenus).filter(k => cfg.headerMenus[k].length).join(','));
	console.log('菜单函数:', cfg.headerMenus.sch[0].menuItems.map(m => m.registerFn).join(', '));
	if (cfg.uuid.length !== 32)
		throw new Error(`uuid 应为 32 位，实际 ${cfg.uuid.length}`);
	const src = await z.file('dist/index.js').async('string');
	console.log('bundle 大小:', src.length, '字节');
	// esbuild 默认 ascii charset：中文字符串会被转成 \uXXXX 转义（大写十六进制），两种形式都匹配
	const esc = s => Array.from(s).map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`).join('');
	const hasStr = s => src.includes(s) || src.includes(esc(s));
	for (const k of ['planNetFanout', 'parseProtel2Netlist', 'applyPlan', 'createNetLabel', 'createNetPort', 'sch_PrimitiveWire', 'sch_SelectControl', 'getAllSelectedPrimitives', 'getState_Rotation', 'sys_Dialog', 'openSettingsPanel', 'runNetFanout', 'previewNetFanout', 'cleanupNetFanout', 'dumpDiagnostics', 'pickSegment', 'resolvePinDirections', 'followWire', 'correctDir', 'dirCorrection', 'resolveLabelStyle', 'supportsNetLabel', 'AdaptivePacer', 'labelAborted', 'createIntervalMs', 'maxRetries', 'failedItems', '跟随鼠标', '忽略名单', 'No ERC'])
		console.log(`  含 ${k}:`, hasStr(k));
	const html = await z.file('iframe/settings.html').async('string');
	for (const k of ['schNetFanoutConfig', 'separator', 'segmentIndex', 'prefix', 'suffix', 'ignoreList', 'placement', 'dirCorrection', 'wireLength', 'labelStyle', 'skipNoConnect', 'createIntervalMs', 'labelAlign', '左右互换', '标签定位', 'btnSave', 'btnDefaults'])
		console.log(`  面板含 ${k}:`, html.includes(k));
	// 关键校验：函数导出（headerMenus registerFn 必须都在 bundle 里）
	for (const fn of ['runNetFanout', 'previewNetFanout', 'cleanupNetFanout', 'dumpDiagnostics', 'openSettingsPanel', 'about']) {
		if (!new RegExp(`(?:function|,)\\s*${fn}\\s*[=(]`).test(src) && !src.includes(`${fn}(`))
			throw new Error(`bundle 缺少导出函数 ${fn}`);
	}
	console.log('✓ 核验通过');
}).catch((e) => {
	console.error('核验失败:', e.message);
	process.exit(1);
});
