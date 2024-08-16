import assert from "assert";
import superagent, { SuperAgentRequest } from 'superagent';
import { fs, size, yaml } from '@hydrooj/utils';
import { filter } from 'lodash';
import Queue from 'p-queue';
import AdmZip from 'adm-zip';
import path from 'path';
import { create } from 'fancy-progress';
import os from 'os';
import proxy from 'superagent-proxy';

const report1 = create('* Total', 'green');
const report2 = create('Problem', 'red');

proxy(superagent);
const p = process.env.https_proxy || process.env.http_proxy || process.env.all_proxy || '';
const queue = new Queue({ concurrency: 5 });

const ScoreTypeMap = {
    GroupMin: 'min',
    Sum: 'sum',
    GroupMul: 'max',
};
const LanguageMap = {
    cpp: 'cc',
};
const RE_SYZOJ = /(https?):\/\/([^/]+)\/(problem|p)\/([0-9]+)\/?/i;

async function _download(url: string, path: string, retry: number) {
    if (fs.existsSync(path)) fs.unlinkSync(path);
    const w = fs.createWriteStream(path);
    let req = superagent.get(url).retry(retry).timeout({ response: 3000, deadline: 60000 }).proxy(p);
    req.pipe(w);
    await new Promise((resolve, reject) => {
        w.on('finish', resolve);
        w.on('error', reject);
        req.on('error', reject);
        req.on('timeout', reject);
    });
    return path;
}

function downloadFile(url: string): SuperAgentRequest;
function downloadFile(url: string, path?: string, retry?: number);
function downloadFile(url: string, path?: string, retry = 3) {
    if (path) return _download(url, path, retry);
    return superagent.get(url).timeout({ response: 3000, deadline: 60000 }).proxy(p).retry(retry);
}

function createWriter(id) {
    const dir = path.join(__dirname, 'downloads', id);
    return (filename: string, content?: Buffer | string) => {
        const target = path.join(dir, filename);
        const targetDir = path.dirname(target);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        if (!content) return target;
        fs.writeFileSync(target, content)
        return '';
    }
}

async function v2(url: string) {
    const res = await superagent.get(`${url}export`);
    assert(res.status === 200, new Error('Cannot connect to target server'));
    assert(res.body.success, new Error((res.body.error || {}).message));
    const p = res.body.obj;
    let c = '';
    if (p.description) {
        c += `## 题目描述\n${p.description}\n\n`
    }
    if (p.input_format) {
        c += `## 输入格式\n${p.input_format}\n\n`
    }
    if (p.output_format) {
        c += `## 输出格式\n${p.output_format}\n\n`
    }
    if (p.example) {
        c += `## 样例\n${p.example}\n\n`
    }
    if (p.hint) {
        c += `## 提示\n${p.hint}\n\n`
    }
    if (p.limit_and_hint) {
        c += `## 限制与提示\n${p.limit_and_hint}\n\n`
    }
    const u = new URL(url);
    const pid = u.pathname.split('problem/')[1].split('/')[0];
    const write = createWriter(u.host + '/' + pid);
    write('problem_zh.md', c);
    write('problem.yaml', yaml.dump({
        title: p.title,
        owner: 1,
        tag: p.tags || [],
        pid: `P${pid}`,
        nSubmit: 0,
        nAccept: 0,
    }));
    const r = downloadFile(`${url}testdata/download`);
    const file = path.resolve(os.tmpdir(), 'hydro', `import_${pid}.zip`);
    const w = fs.createWriteStream(file);
    try {
        await new Promise((resolve, reject) => {
            w.on('finish', resolve);
            w.on('error', reject);
            r.pipe(w);
        });
        const zip = new AdmZip(file);
        const entries = zip.getEntries();
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            write('testdata/' + entry.entryName.split('/').pop(), entry.getData());
        }
        const filename = p.file_io_input_name ? p.file_io_input_name.split('.')[0] : null;
        const config = {
            time: `${p.time_limit || 1000}ms`,
            memory: `${p.memory_limit || 256}m`,
            filename,
            type: p.type === 'traditional' ? 'default' : p.type,
        };
        write('testdata/config.yaml', yaml.dump(config));
    } finally {
        fs.unlinkSync(file);
    }
    if (p.have_additional_file) {
        const r1 = downloadFile(`${url}download/additional_file`);
        const file1 = path.resolve(os.tmpdir(), 'hydro', `import_${pid}_a.zip`);
        const w1 = fs.createWriteStream(file1);
        try {
            await new Promise((resolve, reject) => {
                w1.on('finish', resolve);
                w1.on('error', reject);
                r1.pipe(w1);
            });
            const zip = new AdmZip(file1);
            const entries = zip.getEntries();
            for (const entry of entries) {
                write('additional_file/' + entry.entryName.replace(/\//g, '_'), entry.getData());
            }
        } finally {
            fs.unlinkSync(file1);
        }
    }
}

async function v3(protocol: string, host: string, pid: number) {
    report2.update(0, 'Fetching info');
    const result = await superagent.post(`${protocol}://${host === 'loj.ac' ? 'api.loj.ac' : host}/api/problem/getProblem`)
        .send({
            displayId: pid,
            localizedContentsOfAllLocales: true,
            tagsOfLocale: 'zh_CN',
            samples: true,
            judgeInfo: true,
            testData: true,
            additionalFiles: true,
        })
        .proxy(p);
    if (!result.body.localizedContentsOfAllLocales) {
        // Problem doesn't exist
        return;
    }
    const write = createWriter(host + '/' + pid);
    for (const c of result.body.localizedContentsOfAllLocales) {
        let content = '';
        const sections = c.contentSections;
        let add = false;
        for (const section of sections) {
            if (section.type === 'Sample') {
                if (section.sampleId === 0) add = true;
                content += `\
\`\`\`input${add ? section.sampleId + 1 : section.sampleId}
${result.body.samples[section.sampleId].inputData}
\`\`\`

\`\`\`output${add ? section.sampleId + 1 : section.sampleId}
${result.body.samples[section.sampleId].outputData}
\`\`\`

`;
                if (section.text) {
                    content += `

${section.text}

`;
                }
            } else {
                content += '## ' + section.sectionTitle + '\n';
                content += '\n' + section.text + '\n\n';
            }
        }
        let locale = c.locale;
        if (locale === 'en_US') locale = 'en';
        else if (locale === 'zh_CN') locale = 'zh';
        write('problem_' + locale + '.md', content);
    }
    const tags = result.body.tagsOfLocale.map((node) => node.name);
    const title = [
        ...filter(
            result.body.localizedContentsOfAllLocales,
            (node) => node.locale === 'zh_CN',
        ),
        ...result.body.localizedContentsOfAllLocales,
    ][0].title;
    write('problem.yaml', yaml.dump({
        title,
        owner: 1,
        tag: tags,
        pid: `P${pid}`,
        nSubmit: result.body.meta.submissionCount,
        nAccept: result.body.meta.acceptedSubmissionCount,
    }));
    const judge = result.body.judgeInfo;
    const rename = {};
    if (judge) {
        report2.update(0, 'Fetching judge config');
        const config: ProblemConfigFile = {
            time: `${judge.timeLimit}ms`,
            memory: `${judge.memoryLimit}m`,
        };
        if (judge.extraSourceFiles) {
            const files: string[] = [];
            for (const key in judge.extraSourceFiles) {
                for (const file in judge.extraSourceFiles[key]) {
                    files.push(file);
                }
            }
            config.user_extra_files = files;
        }
        if (judge.checker?.type === 'custom') {
            config.checker_type = judge.checker.interface === 'legacy' ? 'syzoj' : judge.checker.interface;
            if (LanguageMap[judge.checker.language]) {
                rename[judge.checker.filename] = `chk.${LanguageMap[judge.checker.language]}`;
                config.checker = `chk.${LanguageMap[judge.checker.language]}`;
            } else config.checker = judge.checker.filename;
        }
        if (judge.fileIo?.inputFilename) {
            config.filename = judge.fileIo.inputFilename.split('.')[0];
        }
        if (judge.subtasks?.length) {
            config.subtasks = [];
            for (const subtask of judge.subtasks) {
                const current: SubtaskConfig = {
                    score: subtask.points,
                    type: ScoreTypeMap[subtask.scoringType],
                    cases: subtask.testcases.map((i) => ({ input: i.inputFile, output: i.outputFile })),
                };
                if (subtask.dependencies) current.if = subtask.dependencies;
                config.subtasks.push(current);
            }
        }
        write('testdata/config.yaml', Buffer.from(yaml.dump(config)));
    }
    let downloadedSize = 0;
    let totalSize = result.body.testData.map(i => i.size).reduce((a, b) => a + b, 0)
        + result.body.additionalFiles.map(i => i.size).reduce((a, b) => a + b, 0);
    let downloadedCount = 0;
    let totalCount = result.body.testData.length + result.body.additionalFiles.length;
    const [r, a] = await Promise.all([
        superagent.post(`${protocol}://${host === 'loj.ac' ? 'api.loj.ac' : host}/api/problem/downloadProblemFiles`)
            .send({
                problemId: result.body.meta.id,
                type: 'TestData',
                filenameList: result.body.testData.map((node) => node.filename),
            })
            .proxy(p).timeout(10000).retry(5),
        superagent.post(`${protocol}://${host === 'loj.ac' ? 'api.loj.ac' : host}/api/problem/downloadProblemFiles`)
            .send({
                problemId: result.body.meta.id,
                type: 'AdditionalFile',
                filenameList: result.body.additionalFiles.map((node) => node.filename),
            })
            .proxy(p).timeout(10000).retry(5),
    ]);
    if (r.body.error) throw new Error(r.body.error.message || r.body.error);
    if (a.body.error) throw new Error(a.body.error.message || a.body.error);
    const tasks: [name: string, type: 'testdata' | 'additional_file', url: string, size: number][] = [];
    for (const f of r.body.downloadInfo) {
        tasks.push([rename[f.filename] || f.filename, 'testdata', f.downloadUrl, result.body.testData.find(i => i.filename === f.filename).size]);
    }
    for (const f of a.body.downloadInfo) {
        tasks.push([rename[f.filename] || f.filename, 'additional_file', f.downloadUrl, result.body.additionalFiles.find(i => i.filename === f.filename).size]);
    }
    let err;
    for (const [name, type, url, expectedSize] of tasks) {
        queue.add(async () => {
            try {
                const filepath = type + '/' + name;
                if (fs.existsSync('downloads/' + host + '/' + pid + '/' + filepath)) {
                    const size = fs.statSync('downloads/' + host + '/' + pid + '/' + filepath).size;
                                        if (size === expectedSize) {
                        downloadedSize += size;
                        downloadedCount++;
                        return;
                    }else console.log(filepath,size,expectedSize);
                }
                await downloadFile(url, write(filepath));
                downloadedSize += expectedSize;
                downloadedCount++;
                report2.update(downloadedSize / totalSize, `(${size(downloadedSize)}/${size(totalSize)}) ` + name + ' (' + (downloadedCount + 1) + '/' + totalCount + ')');
            } catch (e) {
                console.error(e)
                err = e;
            }
        });
    }
    await queue.onIdle();
    if (err) throw err;
    report2.update(downloadedSize / totalSize, '');
}

async function run(url: string) {
    if (/^(.+)\/(\d+)\.\.(\d+)$/.test(url)) {
        const res = /^(.+)\/(\d+)\.\.(\d+)$/.exec(url)!;
        let prefix = res[1];
        const start = +res[2];
        const end = +res[3];
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
            throw new Error('end');
        }
        let version = 2;
        if (!prefix.endsWith('/')) prefix += '/';
        if (prefix.endsWith('/p/')) version = 3;
        else prefix = `${prefix.split('/problem/')[0]}/problem/`;
        const base = `${prefix}${start}/`;
        assert(base.match(RE_SYZOJ), new Error('prefix'));
        const [, protocol, host] = RE_SYZOJ.exec(base)!;
        const count = end - start + 1;
        for (let i = start; i <= end; i++) {
            report1.update((i - start) / count, prefix + i + '');
            if (version === 3) {
                try {
                    await v3(protocol, host, i);
                } catch (e) {
                    try {
                        await v3(protocol, host, i);
                    } catch (e) {
                        console.error(e);
                    }
                }
            } else await v2(`${prefix}${i}/`);
        }
        report2.update(1, '');
        return;
    }
    assert(url.match(RE_SYZOJ), new Error('This is not a valid SYZOJ/Lyrio problem detail page link.'));
    if (!url.endsWith('/')) url += '/';
    const [, protocol, host, n, pid] = RE_SYZOJ.exec(url)!;
    if (n === 'p') await v3(protocol, host, +pid);
    else await v2(url);
}

process.on('unhandledRejection', (e) => {
    console.error(e);
    setTimeout(() => {
        console.error(e);
        process.exit(1);
    }, 1000);
});
process.on('uncaughtException', (e) => {
    console.error(e);
    setTimeout(() => {
        console.error(e);
        process.exit(1);
    }, 1000);
});

if (!process.argv[2]) console.log('loj-download <url>');
else run(process.argv[2]).catch(e => {
    console.error(e);
    setTimeout(() => {
        console.error(e);
        process.exit(1);
    }, 1000);
});
