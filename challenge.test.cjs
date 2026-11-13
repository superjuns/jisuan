const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const html = readFileSync(`${__dirname}/index.html`, 'utf8');
function between(start, end) {
    return html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
}
function context() {
    const ctx = vm.createContext({ assert });
    vm.runInContext(between('    function createSeededRandom', '    let currentDate'), ctx);
    vm.runInContext(between('    function generateVerticalChallenge', '    function startTimer'), ctx);
    return ctx;
}

test('课堂练习仅保留口算和竖式两部分', () => {
    const markup = between('<div id="classroomPanel"', '<div id="challengePanel"');
    assert.deepEqual(Array.from(markup.matchAll(/class="section-title">([^<]+)/g), m => m[1]), ['一、口算', '二、竖式计算']);
    assert.doesNotMatch(markup, /id="factorGrid"/);
});

test('课堂与闯关共用20题：四类口算与两种易错题逐套覆盖', () => {
    const ctx = context();
    vm.runInContext(`
        for (let seed = 1; seed <= 200; seed++) {
            Date.now = () => seed;
            currentRandom = createSeededRandom(seed);
            const classroom = buildExerciseSet();
            const questions = generateChallengeQuestions();
            assert.equal(questions.length, 20);
            assert.equal(classroom.oral.length, 18);
            assert.equal(classroom.vertical.length, 2);
            assert.deepEqual(questions.map(q => q.text), [...classroom.oral, ...classroom.vertical].map(q => q.text));
            const types=[]; let boundary=false, roundBorrow=false;
            questions.forEach((q, index) => {
                const equation = q.text.replace(/\\(\\s*\\)/, String(q.answer));
                const match = equation.match(/^(\\d+) ([+×-]) (\\d+) = (\\d+)$/);
                assert.ok(match, equation);
                const [, a, op, b, result] = match;
                assert.equal(op === '+' ? +a + +b : op === '×' ? +a * +b : +a - +b, +result);
                if (index >= 10 && index < 18) {
                    assert.equal(op, '×');
                    assert.ok(+a >= 1 && +a <= 9 && +b >= 1 && +b <= 9);
                }
                if (index < 8) {
                    assert.match(q.text, /^\\d+ [+-] \\d+ =/);
                    types.push(op + String(op==='+' ? +a%10 + +b%10>=10 : +a%10<+b%10));
                    boundary ||= op==='-' && +a<20 && +b<10 && +a%10-+b===1;
                    roundBorrow ||= op==='-' && +a%10===0 && +b>=11 && +b%10>0;
                    assert.ok(+result>=0 && +result<=100);
                }
                if (index >= 8 && index < 10) assert.ok(!q.text.endsWith('= (   )'));
                assert.equal(q.answered, false);
                if (index === 16) assert.match(q.text, /^\\(\\s*\\) × [1-9] = \\d+$/);
                if (index === 17) assert.match(q.text, /^[1-9] × \\(\\s*\\) = \\d+$/);
                if (index===18 || index===19) {
                    assert.equal(q.type, 'vertical');
                    assert.match(q.displayHtml, /vertical-calculation/);
                    assert.match(q.displayHtml, /grid-template-columns/);
                    assert.match(q.displayHtml, /vb-input-wide/);
                }
            });
            assert.equal(new Set(types).size,4); assert.ok(boundary && roundBorrow);
            assert.equal(new Set(classroom.oral.slice(10).map(q=>q.text)).size,8);
        }
    `, ctx);
});

test('重开闯关按题集同步总数，答到第20题才结束', () => {
    const ctx = context();
    vm.runInContext(`
        let challengeQuestions=[], totalQ=10, currentIndex=0, correctCount=0;
        let yiqiAnswerStreak=0, wrongQuestions=[], nextQuestionTimer=null, timer=null, seconds=0;
        let isContestMode=false, completed=0;
        const node={style:{}, innerHTML:'', innerText:''};
        const document={getElementById: id => id==='finalResultDisplay' ? null : node, querySelector: () => null};
        function renderCurrentQuestion() {}
        function initYiqiGameSdk() { return null; }
        function triggerAnswerCelebration() {}
        function showFinalResult() { completed++; }
        function setTimeout() { return 1; }
        function clearTimeout() {}
    `, ctx);
    vm.runInContext(between('    function resetChallenge()', '    function initFreePractice'), ctx);
    vm.runInContext(between('    function submitAnswer()', '    async function showFinalResult'), ctx);
    vm.runInContext(`
        resetChallenge();
        assert.equal(totalQ, 20);
        for (currentIndex=0; currentIndex<20; currentIndex++) {
            nextQuestionTimer=null;
            const q=challengeQuestions[currentIndex];
            node.value=String(q.answer);
            node.querySelectorAll=()=>[node];
            submitAnswer();
            assert.equal(completed, currentIndex===19 ? 1 : 0);
        }
        assert.equal(correctCount, 20);
    `, ctx);
});
