import assert from "assert";
import superagent, { SuperAgentRequest } from 'superagent';
import yaml from 'js-yaml';
import fs from 'fs-extra';
import AdmZip from 'adm-zip';
import path from 'path';
import os from 'os';
import { filter } from 'lodash';
import proxy from 'superagent-proxy';
import WebpackBar from './progress';

const report1 = new WebpackBar({
    name: '* Total',
});
const report2 = new WebpackBar({
    name: 'Problem',
    color: 'red',
});

proxy(superagent);

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
    const w = fs.createWriteStream(path);
    let req = superagent.get(url).retry(retry);
    if (process.env.https_proxy) req = req.proxy(process.env.https_proxy)
    req.pipe(w);
    await new Promise((resolve, reject) => {
        w.on('finish', resolve);
        w.on('error', reject);
    });
    return path;
}

function downloadFile(url: string): SuperAgentRequest;
function downloadFile(url: string, path?: string, retry?: number);
function downloadFile(url: string, path?: string, retry = 3) {
    if (path) return _download(url, path, retry);
    return superagent.get(url).retry(retry);
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
    throw new Error('Not implemented');
    const res = await superagent.get(`${url}export`);
    assert(res.status === 200, new Error('Cannot connect to target server'));
    assert(res.body.success, new Error((res.body.error || {}).message));
    const p = res.body.obj;
    const content: ContentNode[] = [];
    if (p.description) {
        content.push({
            type: 'Text',
            subType: 'markdown',
            sectionTitle: this.translate('Problem Description'),
            text: p.description,
        });
    }
    if (p.input_format) {
        content.push({
            type: 'Text',
            subType: 'markdown',
            sectionTitle: this.translate('Input Format'),
            text: p.input_format,
        });
    }
    if (p.output_format) {
        content.push({
            type: 'Text',
            subType: 'markdown',
            sectionTitle: this.translate('Output Format'),
            text: p.output_format,
        });
    }
    if (p.example) {
        content.push({
            type: 'Text',
            subType: 'markdown',
            sectionTitle: this.translate('Sample'),
            text: p.example,
        });
    }
    if (p.hint) {
        content.push({
            type: 'Text',
            subType: 'markdown',
            sectionTitle: this.translate('Hint'),
            text: p.hint,
        });
    }
    if (p.limit_and_hint) {
        content.push({
            type: 'Text',
            subType: 'markdown',
            sectionTitle: this.translate('Limit And Hint'),
            text: p.limit_and_hint,
        });
    }
    const c = buildContent(content, 'markdown');
    const docId = await problem.add(
        target, p.title, c, this.user._id, p.tags || [],
    );
    const r = downloadFile(`${url}testdata/download`);
    const file = path.resolve(os.tmpdir(), 'hydro', `import_${docId}.zip`);
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
            // eslint-disable-next-line no-await-in-loop
            await problem.addTestdata(docId, entry.entryName, entry.getData());
        }
        const filename = p.file_io_input_name ? p.file_io_input_name.split('.')[0] : null;
        const config = {
            time: `${p.time_limit}ms`,
            memory: `${p.memory_limit}m`,
            filename,
            type: p.type === 'traditional' ? 'default' : p.type,
        };
        await problem.addTestdata(docId, 'config.yaml', Buffer.from(yaml.dump(config)));
    } finally {
        fs.unlinkSync(file);
    }
    if (p.have_additional_file) {
        const r1 = downloadFile(`${url}download/additional_file`);
        const file1 = path.resolve(os.tmpdir(), 'hydro', `import_${docId}_a.zip`);
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
                await problem.addAdditionalFile(docId, entry.entryName.replace('/', '_'), entry.getData());
            }
        } finally {
            fs.unlinkSync(file1);
        }
    }
    return docId;
}

async function v3(protocol: string, host: string, pid: number) {
    report2.updateProgress(0, '', ['Fetching info']);
    const result = await superagent.post(`${protocol}://${host === 'loj.ac' ? 'api.loj.ac.cn' : host}/api/problem/getProblem`)
        .send({
            displayId: pid,
            localizedContentsOfAllLocales: true,
            tagsOfLocale: 'zh_CN',
            samples: true,
            judgeInfo: true,
            testData: true,
            additionalFiles: true,
        });
    if (!result.body.localizedContentsOfAllLocales) {
        // Problem doesn't exist
        return;
    }
    const write = createWriter(host + '/' + pid);
    for (const c of result.body.localizedContentsOfAllLocales) {
        let content = '';
        const sections = c.contentSections;
        for (const section of sections) {
            if (section.type === 'Sample') {
                content += `\
\`\`\`input${section.sampleId}
${result.body.samples[section.sampleId].inputData}
\`\`\`

\`\`\`output${section.sampleId}
${result.body.samples[section.sampleId].outputData}
\`\`\`

`;
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
        report2.updateProgress(0, '', ['Fetching judge config']);
        const config: ProblemConfigFile = {
            time: `${judge.timeLimit}ms`,
            memory: `${judge.memoryLimit}m`,
        };
        if (judge.extraSourceFiles) {
            const files = [];
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
    const r = await superagent.post(`${protocol}://${host === 'loj.ac' ? 'api.loj.ac.cn' : host}/api/problem/downloadProblemFiles`)
        .send({
            problemId: result.body.meta.id,
            type: 'TestData',
            filenameList: result.body.testData.map((node) => node.filename),
        });
    if (r.body.error) throw new Error(r.body.error.message || r.body.error);
    for (const f of r.body.downloadInfo) {
        report2.updateProgress(downloadedSize / totalSize, '', [f.filename + ' (' + (downloadedCount + 1) + '/' + totalCount + ')']);
        await downloadFile(f.downloadUrl, write('testdata/' + (rename[f.filename] || f.filename)));
        downloadedSize += result.body.testData.find(i => i.filename === f.filename).size;
        downloadedCount++;
    }
    const a = await superagent.post(`${protocol}://${host === 'loj.ac' ? 'api.loj.ac.cn' : host}/api/problem/downloadProblemFiles`)
        .send({
            problemId: result.body.meta.id,
            type: 'AdditionalFile',
            filenameList: result.body.additionalFiles.map((node) => node.filename),
        });
    if (a.body.error) throw new Error(a.body.error.message || a.body.error);
    for (const f of a.body.downloadInfo) {
        report2.updateProgress(downloadedSize / totalSize, '', [f.filename + ' (' + (downloadedCount + 1) + '/' + totalCount + ')']);
        await downloadFile(f.downloadUrl, write('additional_file/' + f.filename));
        downloadedSize += result.body.additionalFiles.find(i => i.filename === f.filename).size;
        downloadedCount++;
    }
    report2.updateProgress(downloadedSize / totalSize, '', ['']);
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
        const [, protocol, host] = RE_SYZOJ.exec(base);
        const count = end - start + 1;
        for (let i = start; i <= end; i++) {
            report1.updateProgress((i - start) / count, '', [prefix + i + '']);
            if (version === 3) await v3(protocol, host, i);
            else await v2(`${prefix}${i}/`);
        }
        report2.updateProgress(1, '', ['']);
        return;
    }
    assert(url.match(RE_SYZOJ), new Error('url'));
    if (!url.endsWith('/')) url += '/';
    const [, protocol, host, n, pid] = RE_SYZOJ.exec(url);
    if (n === 'p') await v3(protocol, host, +pid)
    else await v2(url);
}

if (!process.argv[2]) console.log('loj-download <url>');
else run(process.argv[2]).catch(e => {
    console.error(e);
    process.exit(1);
});
