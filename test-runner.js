/**
 * COSMIC拆分系统 - 自动化测试脚本
 * 使用 test-doc.txt 进行完整的分析流程测试
 */
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3005';

async function post(endpoint, body) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`API错误 ${res.status}: ${err}`);
    }
    return res.json();
}

async function uploadFile(filePath) {
    const formData = new FormData();
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: 'text/plain' });
    formData.append('file', blob, path.basename(filePath));

    const res = await fetch(`${BASE_URL}/api/parse-word`, {
        method: 'POST',
        body: formData
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`上传失败 ${res.status}: ${err}`);
    }
    return res.json();
}

function printSeparator(title) {
    console.log('\n' + '═'.repeat(60));
    console.log(`  ${title}`);
    console.log('═'.repeat(60));
}

function printTable(tableData) {
    if (!tableData || tableData.length === 0) {
        console.log('  (无数据)');
        return;
    }

    // 打印表头
    console.log('┌────────────────┬──────────┬────────────────────┬──────────────────────────┬──────┬──────────────────────┬────────────────────┐');
    console.log('│ 功能用户       │ 触发事件 │ 功能过程           │ 子过程描述               │ 类型 │ 数据组               │ 数据属性           │');
    console.log('├────────────────┼──────────┼────────────────────┼──────────────────────────┼──────┼──────────────────────┼────────────────────┤');

    let currentProcess = '';
    tableData.forEach((row, i) => {
        const user = (row.functionalUser || '').substring(0, 14).padEnd(14);
        const trigger = (row.triggerEvent || '').substring(0, 8).padEnd(8);
        const proc = (row.functionalProcess || '').substring(0, 18).padEnd(18);
        const desc = (row.subProcessDesc || '').substring(0, 24).padEnd(24);
        const type = (row.dataMovementType || '').padEnd(4);
        const group = (row.dataGroup || '').substring(0, 20).padEnd(20);
        const attrs = (row.dataAttributes || '').substring(0, 18).padEnd(18);

        if (row.functionalProcess && row.functionalProcess !== currentProcess) {
            if (currentProcess) {
                console.log('├────────────────┼──────────┼────────────────────┼──────────────────────────┼──────┼──────────────────────┼────────────────────┤');
            }
            currentProcess = row.functionalProcess;
        }

        console.log(`│ ${user} │ ${trigger} │ ${proc} │ ${desc} │ ${type} │ ${group} │ ${attrs} │`);
    });
    console.log('└────────────────┴──────────┴────────────────────┴──────────────────────────┴──────┴──────────────────────┴────────────────────┘');
}

async function main() {
    console.log('🚀 COSMIC拆分系统 - 自动化测试开始');
    console.log(`⏰ 时间: ${new Date().toLocaleString()}`);
    console.log(`🌐 服务地址: ${BASE_URL}`);

    // ═══════ 步骤0: 健康检查 ═══════
    printSeparator('步骤0: 健康检查');
    try {
        const health = await fetch(`${BASE_URL}/api/health`).then(r => r.json());
        console.log(`  ✅ 服务状态: ${health.status}`);
        console.log(`  📊 当前模型: ${health.model}`);
        console.log(`  🔗 平台: ${health.platform}`);
    } catch (e) {
        console.error('  ❌ 服务不可用:', e.message);
        return;
    }

    // ═══════ 步骤1: 上传文档 ═══════
    printSeparator('步骤1: 上传并解析文档');
    const testDocPath = path.join(__dirname, 'test-doc.txt');
    console.log(`  📄 测试文件: ${testDocPath}`);

    let documentContent;
    try {
        const parseResult = await uploadFile(testDocPath);
        documentContent = parseResult.text;
        console.log(`  ✅ 解析成功！`);
        console.log(`  📏 文档长度: ${documentContent.length} 字符`);
        console.log(`  📝 文档预览: ${documentContent.substring(0, 100)}...`);
    } catch (e) {
        console.error('  ❌ 文档解析失败:', e.message);
        // 直接读取文件内容作为备选
        documentContent = fs.readFileSync(testDocPath, 'utf-8');
        console.log('  📄 使用直接文件读取, 长度:', documentContent.length);
    }

    // ═══════ 步骤2: 文档理解 ═══════
    printSeparator('步骤2: AI深度理解文档');
    console.log('  ⏳ 正在调用AI分析文档结构...(可能需要30-60秒)');

    let understanding;
    try {
        const understandResult = await post('/api/understand-document', { documentContent });
        understanding = understandResult.understanding;

        console.log(`  ✅ 文档理解完成！`);
        console.log(`  📋 项目名称: ${understanding.projectName}`);
        console.log(`  📝 项目描述: ${understanding.projectDescription}`);

        if (understanding.coreModules) {
            console.log(`  📦 核心模块 (${understanding.coreModules.length}个):`);
            understanding.coreModules.forEach((m, i) => {
                const funcs = m.estimatedFunctions || [];
                const funcNames = Array.isArray(funcs) && funcs.length > 0 && typeof funcs[0] === 'object'
                    ? funcs.map(f => f.functionName).join('、')
                    : (Array.isArray(funcs) ? funcs.join('、') : '');
                console.log(`    ${i + 1}. ${m.moduleName}: ${funcNames}`);
            });
        }

        if (understanding.businessEntities) {
            console.log(`  🏢 业务实体 (${understanding.businessEntities.length}个):`);
            understanding.businessEntities.forEach((e, i) => {
                console.log(`    ${i + 1}. ${e.entityName}${e.hasLifecycle ? ' (有生命周期)' : ''}`);
            });
        }

        if (understanding.totalEstimatedFunctions) {
            console.log(`  🎯 预估功能过程数: ${understanding.totalEstimatedFunctions}`);
        }
    } catch (e) {
        console.error('  ❌ 文档理解失败:', e.message);
        understanding = null;
    }

    // ═══════ 步骤3: 章节识别 ═══════
    printSeparator('步骤3: 章节结构识别');
    try {
        const chapterResult = await post('/api/split-chapters', { documentContent });
        console.log(`  ✅ 识别到 ${chapterResult.count} 个章节:`);
        chapterResult.chapters.forEach((ch, i) => {
            console.log(`    ${i + 1}. ${ch.title} (${ch.charCount}字)${ch.selected ? '' : ' [跳过]'}`);
        });
    } catch (e) {
        console.error('  ❌ 章节识别失败:', e.message);
    }

    // ═══════ 步骤4: 一键COSMIC分析（使用continue-analyze接口） ═══════
    printSeparator('步骤4: 一键COSMIC拆分分析');
    console.log('  ⏳ 开始COSMIC拆分...(这是最关键的步骤，可能需要1-3分钟)');

    let allResults = [];
    let round = 1;
    let isDone = false;
    const targetFunctions = understanding?.totalEstimatedFunctions
        ? Math.ceil(understanding.totalEstimatedFunctions * 1.1)
        : 30;
    console.log(`  🎯 目标功能过程数: ${targetFunctions}${understanding?.totalEstimatedFunctions ? '（基于文档理解预估）' : ''}`);
    let lastCoverage = null;

    try {
        while (!isDone && round <= 15) {
            console.log(`\n  🔄 第 ${round} 轮分析...`);
            const startTime = Date.now();

            const analyzeResult = await post('/api/continue-analyze', {
                documentContent,
                previousResults: allResults,
                round,
                targetFunctions,
                understanding,
                userGuidelines: '',
                coverageVerification: lastCoverage
            });

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`  ⏱️ 耗时: ${elapsed}秒`);

            // 解析本轮结果中的表格
            if (analyzeResult.reply && analyzeResult.reply.includes('|')) {
                const parseResult = await post('/api/parse-table', { markdown: analyzeResult.reply });
                if (parseResult.tableData && parseResult.tableData.length > 0) {
                    allResults = [...allResults, ...parseResult.tableData];
                    console.log(`  📊 本轮新增 ${parseResult.tableData.length} 条子过程`);
                }
            }

            // 统计当前功能过程数
            const uniqueProcesses = [...new Set(allResults.map(r => r.functionalProcess).filter(Boolean))];
            console.log(`  📈 累计: ${uniqueProcesses.length} 个功能过程, ${allResults.length} 条子过程`);

            isDone = analyzeResult.isDone;
            lastCoverage = analyzeResult.coverageVerification || null;
            if (lastCoverage) {
                console.log(`  📊 覆盖度验证: ${lastCoverage.coverageScore}分, 遗漏${lastCoverage.missedFunctions?.length || 0}个`);
            }
            if (isDone) {
                console.log(`  ✅ 分析完成！`);
            }
            round++;
        }
    } catch (e) {
        console.error('  ❌ COSMIC分析失败:', e.message);
    }

    // ═══════ 步骤5: 输出结果 ═══════
    if (allResults.length > 0) {
        printSeparator('步骤5: COSMIC拆分结果');

        // 统计
        const uniqueProcesses = [...new Set(allResults.map(r => r.functionalProcess).filter(Boolean))];
        const typeCounts = { E: 0, R: 0, W: 0, X: 0 };
        allResults.forEach(r => {
            const t = r.dataMovementType;
            if (typeCounts[t] !== undefined) typeCounts[t]++;
        });

        console.log(`\n  📊 统计概览:`);
        console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`  功能过程总数: ${uniqueProcesses.length}`);
        console.log(`  子过程总数:   ${allResults.length}`);
        console.log(`  CFP总点数:    ${allResults.length}`);
        console.log(`  E(输入):    ${typeCounts.E}`);
        console.log(`  R(读取):    ${typeCounts.R}`);
        console.log(`  W(写入):    ${typeCounts.W}`);
        console.log(`  X(输出):    ${typeCounts.X}`);
        console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        // 按功能过程分组输出
        console.log(`\n  📋 功能过程列表:`);
        uniqueProcesses.forEach((proc, i) => {
            const subProcesses = allResults.filter(r => r.functionalProcess === proc);
            const types = subProcesses.map(r => r.dataMovementType).join(',');
            console.log(`    ${(i + 1).toString().padStart(2)}. ${proc} [${types}] (${subProcesses.length}个子过程)`);
        });

        // 打印详细表格
        console.log('\n  📊 详细COSMIC拆分表格:');
        printTable(allResults);
    } else {
        console.log('\n  ⚠️ 未能获取到分析结果');
    }

    printSeparator('测试完成');
    console.log(`  ⏰ 结束时间: ${new Date().toLocaleString()}`);
}

main().catch(err => {
    console.error('测试脚本出错:', err);
});
