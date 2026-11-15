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

function roundContext() {
    const ctx = context();
    vm.runInContext(`
        let challengeQuestions=[],totalQ=20,currentIndex=0,correctCount=0,yiqiAnswerStreak=0,wrongQuestions=[],timer=null,seconds=0;
        let phase='active',startedAt=null,roundToken='synthetic-test',pending=null,panelActive=true,completed=0,epoch=0,advanceTimer=null;
        let scheduled=null;function setTimeout(cb){scheduled=cb;return 1;}
        const n={style:{},dataset:{},textContent:'',value:'',innerHTML:'',innerText:'',focus(){},select(){this.selected=true;}};
        const el=()=>n;
        let vibrations=0,shakes=0;const navigator={vibrate(){vibrations++;}};
        const card={hidden:false,classList:{remove(){},add(c){if(c==='yiqi-answer-wrong')shakes++;}},querySelector:()=>null,appendChild(){}};
        const document={getElementById:id=>id==='finalResultDisplay'?null:n,querySelector:()=>card,createElement:()=>({})};
        let boxes=[n];n.querySelectorAll=()=>boxes;
        function renderCurrentQuestion() {}
        function startTimer(){startedAt=100;seconds=1;}
        function stopTimer(){}
        function triggerAnswerCelebration(){}
        function yiqiPlayTone(){}
        function emitGame(){}
        function saveResult(){phase='saving';completed++;}
    `,ctx);
    vm.runInContext(between('    function resetChallenge(seed)', '    let activeInputElement'),ctx);
    vm.runInContext(between('    function correctionHint(', '    function showResultStatus'),ctx);
    return ctx;
}
test('登录后直接开始，第20题只提交完整的同一轮答案，不传客户端身份或分数', () => {
    const ctx=roundContext();
    vm.runInContext(`
        resetChallenge(1001);
        assert.equal(totalQ,20);
        assert.equal(startedAt,null);
        submitAnswer();
        assert.equal(currentIndex,0);
        assert.equal(startedAt,null);
        for(let i=0;i<20;i++){
            const q=challengeQuestions[i];n.value=String(q.answer);
            submitAnswer();
            assert.equal(completed,i===19?1:0);
        }
        submitAnswer();assert.equal(completed,1);
        assert.equal(pending.attempt,roundToken);
        assert.equal(pending.answers.length,20);
        assert.equal(pending.answers[0].userAnswer,String(challengeQuestions[0].answer));
        assert.ok(pending.answers.every(a=>a.finalAnswer===a.userAnswer));
        assert.deepEqual(Object.keys(pending).sort(),['answers','attempt','elapsedSeconds']);
        assert.equal(correctCount,20);
    `,ctx);
});

test('错留原题、空答不记错、反复点不多计、改对后才前进；末题也要订正，回执保留首答', () => {
    vm.runInContext(`
        resetChallenge(1001);
        for(let i=0;i<20;i++){
            const q=challengeQuestions[i],mistake=i===0||i===19;
            if(mistake){
                if(i===19){
                    boxes=[n,{value:'',focus(){}}];n.value='7';submitAnswer();
                    assert.equal(q.firstAnswer,null);assert.equal(q.wrongTries,0);
                    assert.match(n.textContent,/填完整/);boxes=[n];
                }
                n.value='999';submitAnswer();
                assert.equal(q.firstAnswer,'999');assert.equal(q.finalAnswer,null);
                assert.equal(currentIndex,i);assert.equal(n.selected,true);
                assert.equal(wrongQuestions.length,i===0?1:2);
                submitAnswer();assert.equal(q.wrongTries,1);
                for(let j=2;j<=3;j++){q.needsEdit=false;n.value=String(999-j);submitAnswer();}
                assert.match(n.textContent,/①/);assert.equal(q.firstAnswer,'999');assert.equal(q.wrongTries,3);
            }
            q.needsEdit=false;n.value=String(q.answer);submitAnswer();
            if(mistake){
                assert.equal(currentIndex,i);assert.match(n.textContent,/改对了/);assert.equal(completed,0);
                submitAnswer();scheduled();submitAnswerWithNoInput();
            }
        }
        function submitAnswerWithNoInput(){n.value='';submitAnswer();}
        assert.equal(completed,1);assert.equal(correctCount,18);assert.equal(wrongQuestions.length,2);assert.equal(vibrations,2);assert.equal(shakes,2);
        assert.equal(pending.answers.length,20);assert.equal(pending.answers[19].userAnswer,'999');
        assert.equal(pending.answers[19].finalAnswer,String(challengeQuestions[19].answer));
    `,roundContext());
});
test('订正提示列出本题需要的计算步骤，不把不退位当成退位，也不把乘数当成积',()=>{
    vm.runInContext(`
        assert.match(correctionHint('16 - 5 = (   )',2),/不用退位/);
        assert.match(correctionHint('80 - 51 = (   )',3),/10 − 1/);
        assert.match(correctionHint('100 - 78 = (   )',3),/9个十/);
        assert.match(correctionHint('35 + 25 = (   )',2),/满十要/);
        assert.match(correctionHint('35 + 24 = (   )',2),/不用进位/);
        assert.match(correctionHint('59 + 41 = (   )',3),/向百位进1/);
        assert.ok(correctionHint('(   ) - 25 = 36',3).includes('36 + 25'));
        assert.match(correctionHint('71 - (   ) = 35',3),/71 − 35/);
        assert.match(correctionHint('17 + (   ) = 40',3),/40 − 17/);
        assert.match(correctionHint('4 × (   ) = 12',3),/每次加4，一直数到12/);
        assert.match(correctionHint('5 × 3 = (   )',3),/数3个，一共数5次/);
    `, roundContext());
});
test('切换课堂／重开后旧题延迟回调不能推进本轮',()=>{
    vm.runInContext(`
        resetChallenge(22);const q=challengeQuestions[0];n.value='999';submitAnswer();
        q.needsEdit=false;n.value=String(q.answer);submitAnswer();
        const stale=scheduled;++epoch;resetChallenge(23);stale();
        assert.equal(currentIndex,0);assert.equal(challengeQuestions[0].answered,false);
        assert.equal(pending,null);assert.equal(correctCount,0);
    `, roundContext());
});
