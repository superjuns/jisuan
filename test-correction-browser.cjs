// Run: node test-correction-browser.cjs [--production]
// Playwright + Chromium are required (or set PLAYWRIGHT_MODULE, CHROME_PATH).
// Production mode downloads only the public static game HTML. The test browser
// is deliberately offline-by-default: all traffic is fulfilled locally or blocked.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createHash } = require('node:crypto');
const fixtureOrigin = 'https://daily-practice-fixture.invalid';
const gamePath = '/api/game-preview/daily-practice';
const apiPath = '/api/daily-practice';
const isProduction = process.argv.includes('--production');
function getPlaywright() {
    for (const name of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.resolve(path.dirname(process.execPath), '../node_modules/playwright')].filter(Boolean)) {
        try { return require(require.resolve(name)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
    }
    throw Error('Playwright not found; set PLAYWRIGHT_MODULE to an installed Playwright.');
}
async function readGame() {
    if (!isProduction) return fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const url = 'https://www.cn07.cn' + gamePath;
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, 'public static HTML unavailable; do not bypass access protection');
    assert.match(response.headers.get('content-type') || '', /html/i, 'expected the public HTML game');
    const html = await response.text();
    assert.match(html, /id="dailyRoundUI"/);
    return html;
}
function solve(text) {
    const normalized = text.replace(/\(\s*\)/g, '?').replace(/[−–]/g, '-').replace(/\s+/g, '');
    const match = /^([0-9]+|\?)([+×-])([0-9]+|\?)=([0-9]+|\?)$/.exec(normalized);
    assert.ok(match, 'unexpected worksheet equation: ' + text);
    const [, left, op, right, result] = match;
    const calc = (a,b) => op === '+' ? a+b : op === '-' ? a-b : a*b;
    // Solve from the visible equation, without consulting the game's answer key.
    const solutions = Array.from({length: 101}, (_, k) => k).filter(n =>
        calc(left==='?' ? n : Number(left), right==='?' ? n : Number(right)) === (result==='?' ? n : Number(result)));
    assert.equal(solutions.length, 1, text);
    return solutions[0];
}
async function displayedEquation(page) {
    return page.locator('#currentQuestionDisplay').evaluate(el => {
        const vertical = el.querySelector('.vertical-calculation');
        if (vertical) {
            return [...vertical.querySelectorAll('.vb-operand')].map(row => row.textContent.replace(/\s+/g, '')).join('') + '=?';
        }
        const clone = el.cloneNode(true);
        clone.querySelector('input').replaceWith('?');
        return clone.textContent;
    });
}
async function verifyPlaces(page, value, container='#currentQuestionDisplay') {
    const {digits, slots, editor} = await page.locator(container+' .vertical-calculation').evaluate(el=>{
        const center = rect => rect.x+rect.width/2;
        const glyphCenter = node => {
            const range = document.createRange(); range.selectNodeContents(node);
            return center(range.getBoundingClientRect());
        };
        const digits = [...el.querySelectorAll('.vb-operand [data-place]')].filter(n=>/^\d$/.test(n.textContent.trim()))
            .map(n=>({place:Number(n.dataset.place),x:glyphCenter(n)}));
        const slots = [...el.querySelectorAll('.vb-answer-cell[data-place]')].filter(n=>
            n.getBoundingClientRect().width>0 && getComputedStyle(n).visibility!=='hidden')
            .map(n=>({place:Number(n.dataset.place), digit:n.textContent.trim(), x:center(n.getBoundingClientRect()), glyphX:glyphCenter(n)}));
        return {digits,slots,editor:el.querySelector('.vb-input-wide').value};
    });
    assert.equal(editor,value);
    const unit=digits.find(d=>d.place===0)?.x, ten=digits.find(d=>d.place===1)?.x;
    assert.ok(unit>ten,'missing operand digits for tens/units');
    const at = place=>unit-place*(unit-ten);
    for(const d of digits) assert.ok(Math.abs(d.x-at(d.place))<=1,'operands disagree at place '+d.place);
    const expectedPlaces=new Set([...digits.map(d=>d.place),...Array.from(value,(_,i)=>i)]);
    assert.deepEqual(slots.map(s=>s.place).sort(),[...expectedPlaces].sort(),'missing place or unexpected empty leading box');
    for(const s of slots) {
        const target=at(s.place);
        assert.ok(Math.abs(s.x-target)<=1,`answer box at place ${s.place} centered on ${s.x} instead of ${target}`);
        assert.equal(s.digit.match(/\d/g)?.join('')||'',value.at(-1-s.place)||'','wrong digit in place '+s.place);
        if(/^\d$/.test(s.digit)) assert.ok(Math.abs(s.glyphX-target)<=1,`answer digit at place ${s.place} centered on ${s.glyphX} instead of ${target}`);
    }
}
async function verifyExampleLayout(page) {
    // Fixed visual examples exercise both column widths even as worksheet sampling changes.
    // Separate fixture DOM: never mutate the active question, interaction state or receipt.
    const container='#qa-place-fixture';
    await page.evaluate(()=>{
        const fixture=document.createElement('div');
        fixture.id='qa-place-fixture';fixture.className='current-question';
        document.body.appendChild(fixture);
    });
    try{
        for(const example of [{a:59,b:27,op:'+',result:86},{a:100,b:64,op:'-',result:36}]){
            await page.locator(container).evaluate((el,item)=>{el.innerHTML=buildVerticalAnswerHTML(item,true);},example);
            for(const value of ['', '9', String(example.result), '999', '']){
                await page.locator(container+' input').evaluate((input,text)=>{input.value=text;paintVerticalInput(input);},value);
                await verifyPlaces(page,value,container);
            }
        }
    }finally{await page.locator(container).evaluate(el=>el.remove());}
}
async function verify(html, browser, viewport) {
    const touch = viewport.width <= 768;
    const context = await browser.newContext({viewport, serviceWorkers: 'block', hasTouch: touch});
    context.setDefaultTimeout(4500);
    const sends = [], receipts = new Map(), errors = [], unexpected = [];
    const token = 'synthetic-local-round';
    let begins = 0, failOnce = true;
    await context.routeWebSocket('**/*', ws => { unexpected.push('WebSocket'); ws.close(); });
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        const ok = body => route.fulfill({status: 200, json: body});
        if (req.method()==='GET' && url.origin===fixtureOrigin && url.pathname===gamePath)
            return route.fulfill({contentType:'text/html; charset=utf-8', body: html});
        if (url.origin===fixtureOrigin && url.pathname===apiPath) {
            if (req.method()==='GET' && url.searchParams.get('view')==='leaderboard') return ok({rows:[]});
            if (req.method()==='GET' && url.searchParams.get('mode')==='correction' && url.searchParams.get('worksheet')==='3') {
                begins++;
                return ok({student:{class:'模拟班',name:'虚构测试'}, attempt: token+begins, quotaKey: 'fake-key', seed:viewport.width+begins, mode:'correction', worksheet:3});
            }
            if (req.method()==='POST') {
                const post = req.postDataJSON();
                sends.push(post);
                try {
                    assert.deepEqual(Object.keys(post).sort(), ['answers','attempt','elapsedSeconds']);
                    assert.equal(post.attempt, token+begins);
                    assert.ok(Number.isInteger(post.elapsedSeconds) && post.elapsedSeconds > 0);
                    assert.equal(post.answers.length, 20);
                    let score = 0;
                    for (const item of post.answers) {
                        assert.deepEqual(Object.keys(item).sort(), ['finalAnswer','text','userAnswer']);
                        assert.match(item.userAnswer, /^\d{1,3}$/);
                        const n = solve(item.text);
                        assert.equal(Number(item.finalAnswer), n, 'incorrect final answer in a completed round');
                        score += Number(item.userAnswer) === n ? 1 : 0;
                    }
                    const previous = receipts.get(post.attempt);
                    if (previous) assert.deepEqual(post, previous.post, 'retry changed the receipt');
                    if (!previous) receipts.set(post.attempt, {post, result: {saved:true, score, time:post.elapsedSeconds}});
                    // Service committed, but the response was lost. Retry must send identical data.
                    if (failOnce) { failOnce=false; return route.abort('internetdisconnected'); }
                    await delay(60);
                    return ok(receipts.get(post.attempt).result);
                } catch(e) { errors.push(e.message); return route.fulfill({status:422,json:{error:'invalid synthetic receipt'}}); }
            }
            unexpected.push(req.method()+' '+url.pathname+url.search);
        } else if (req.method()!=='GET' || ['xhr','fetch','eventsource'].includes(req.resourceType())) {
            unexpected.push(req.method()+' '+url.pathname);
        }
        // Third-party export/confetti scripts are unrelated; never fetch them.
        return route.abort();
    });
    await context.addInitScript(() => {
        localStorage.setItem('yiqi_game_sound','off');
        window.qaEvents = [];
        for (const type of ['answer:wrong','score-submitted','mistakes-recorded','progress:changed']) {
            addEventListener('yiqi:'+type, e => window.qaEvents.push({type, detail:e.detail.detail}));
        }
        window.qaShakes=0;
        window.qaHaptics=[];
        window.qaNativeEditorFocus=0;
        document.addEventListener('focusin', ({target})=>{
            if(target.matches('#currentQuestionDisplay input') && !target.readOnly && target.inputMode!=='none')window.qaNativeEditorFocus++;
        });
        Object.defineProperty(navigator,'vibrate',{configurable:true,value:ms=>{window.qaHaptics.push(ms);return true;}});
        addEventListener('animationstart', e=>{if(e.animationName==='yiqi-daily-shake')window.qaShakes++;});
    });
    try {
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(e.message));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(fixtureOrigin+gamePath);
        const num = page.locator('#currentQuestionNum'), input = page.locator('#currentQuestionDisplay input');
        const submit = page.locator('#numpad [data-action=submit]'), feedback=page.locator('#currentFeedback');
        const waitNum = n => num.filter({hasText:new RegExp('第\\s*'+n+'\\s*题')}).waitFor({state:'visible'});
        const assertNum = async n => assert.match(await num.innerText(), new RegExp('第\\s*'+n+'\\s*题'));
        const clickTwice = loc => loc.evaluate(el => { el.click(); el.click(); });
        const activate = loc => touch ? loc.tap() : loc.click();
        const digits = async value => {
            for (const ch of String(value)) await activate(page.locator('#numpad [data-digit="'+ch+'"]'));
        };
        const del = () => activate(page.locator('#numpad [data-action="del"]'));
        const write = async value => {
            if(touch) await digits(value); else await input.fill(String(value));
            assert.equal(await input.inputValue(),String(value),'first digit must replace a pending correction');
        };
        const verifyTouchInput = async () => {
            // Headless browsers cannot expose iOS keyboard chrome. A read-only
            // field plus inputmode=none must already be in effect before a tap.
            assert.deepEqual(await input.evaluate(i=>[i.readOnly,i.inputMode]),[true,'none']);
            assert.equal(await page.evaluate(()=>window.qaNativeEditorFocus),0,'focused a keyboard-capable answer field');
        };
        const answer = async () => solve(await displayedEquation(page));
        const noSaves = () => assert.equal(sends.length,0,'unfinished work sent a result');
        const checkLayout = async () => {
            const width = await page.evaluate(()=>[innerWidth,document.documentElement.scrollWidth]);
            assert.ok(width[1]<=width[0]+1,'body overflows horizontally: '+width);
            for(const selector of ['#currentFeedback','#currentQuestionDisplay input','#numpad [data-action=submit]']) {
                const box=await page.locator(selector).boundingBox();
                assert.ok(box && box.x>=-1 && box.x+box.width<=width[0]+1,'clipped control: '+selector);
            }
        };
        await waitNum(1); await checkLayout();
        await verifyExampleLayout(page);
        assert.equal(await page.evaluate(()=>matchMedia('(pointer: coarse)').matches),touch);
        if(touch) {
            await verifyTouchInput(); await input.tap();
            await activate(submit); await assertNum(1); await verifyTouchInput();
            assert.match(await feedback.innerText(),/输入/);
        }
        await write('999'); await activate(submit); await activate(submit);
        await page.waitForFunction(()=>window.qaShakes>=1);
        const t1=await feedback.innerText();
        assert.match(t1,/改一改|再试/); await assertNum(1);
        assert.equal(await input.inputValue(),'999','keep the original answer visible until editing');
        if(touch) await verifyTouchInput();
        else assert.deepEqual(await input.evaluate(i=>[i.selectionStart,i.selectionEnd, i===document.activeElement]),[0,3,true]);
        await delay(350); assert.equal(await page.evaluate(()=>window.qaShakes),1,'repeated click replayed shake');
        assert.equal(await page.evaluate(()=>window.qaHaptics.length),1,'repeated click replayed haptic');
        // Page keypad works without an editable native text selection on a phone.
        await digits('9'); assert.equal(await input.inputValue(),'9');
        await digits('0'); await del(); assert.equal(await input.inputValue(),'9');
        await digits('98'); assert.equal(await input.inputValue(),'998'); await activate(submit);
        const t2=await feedback.innerText(); assert.notEqual(t1,t2,'second error needs a targeted hint'); await assertNum(1);
        await del(); assert.equal(await input.inputValue(),'','first delete after a wrong answer clears it');
        await write('997'); await activate(submit);
        const t3=await feedback.innerText(); assert.notEqual(t2,t3,'third error needs step guidance'); assert.match(t3,/①[\s\S]*②/); await assertNum(1);
        await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
        assert.deepEqual(await page.evaluate(()=>[window.qaShakes,window.qaHaptics.length]),[1,1],
            'only the first actual mistake on this question should shake/vibrate');
        await checkLayout(); noSaves();
        if(touch) await verifyTouchInput();
        // Mode switch during a scheduled correct answer must cancel that old callback.
        const first=await answer();
        await write(first);
        await page.evaluate(()=>{
            document.querySelector('#numpad [data-action=submit]').click();
            document.querySelector('#classModeBtn').click();
            document.querySelector('#challengeModeBtn').click();
        });
        await page.waitForFunction(()=>!document.querySelector('#dailyRoundUI').hidden);
        assert.equal(begins,2,'switching modes must start a new round');
        await delay(800); await assertNum(1); noSaves();
        for(let i=1;i<=20;i++){
            await waitNum(i); const correct=await answer();
            if(touch) await verifyTouchInput();
            if(i>=19) await verifyPlaces(page,'');
            if ([1,19,20].includes(i)){
                if(!touch && i===1){
                    await input.click(); await page.keyboard.type('999'); await page.keyboard.press('Enter');
                }else{
                    await write('999'); await activate(submit);
                }
                await assertNum(i);
                if(i>=19) {
                    assert.equal(await page.locator('#currentQuestionDisplay .vertical-calculation').count(),1);
                    // The wrong-answer shake is transient; measure the settled positions.
                    await delay(350); await verifyPlaces(page,'999');
                    if(touch) { await input.tap(); await verifyTouchInput(); }
                    await write('998'); await activate(submit); const hint=await feedback.innerText();
                    await del(); await verifyPlaces(page,'');
                    await digits('9'); await verifyPlaces(page,'9');
                    await digits('0'); await verifyPlaces(page,'90'); await del(); await verifyPlaces(page,'9');
                    await del(); await verifyPlaces(page,'');
                    await write('997'); await activate(submit); const steps=await feedback.innerText();
                    assert.notEqual(hint,steps); assert.match(steps,/①[\s\S]*②/);
                    if(/^100[-−]/.test((await displayedEquation(page)).replace(/\s+/g,''))) assert.match(steps,/百/,'borrowing across zero must mention the hundreds place');
                    await checkLayout(); await assertNum(i); noSaves();
                }
            }
            if(!touch && i===1){
                // A hardware keyboard must still replace, backspace, and submit via Enter.
                await page.keyboard.type('0'); assert.equal(await input.inputValue(),'0');
                await page.keyboard.press('Backspace'); assert.equal(await input.inputValue(),'');
                await page.keyboard.type(String(correct)); await page.keyboard.press('Enter');
            }else{
                await write(correct);
                if(i>=19) await verifyPlaces(page,String(correct));
                if ([1,19,20].includes(i)) { await activate(submit); await clickTwice(submit); }
                else await activate(submit);
            }
            if ([1,19,20].includes(i)) assert.match(await feedback.innerText(),/改对了/);
        }
        const status=page.locator('#challengeResultMsg'), retry=status.getByRole('button',{name:'重试保存'});
        await retry.waitFor(); assert.equal(sends.length,1); assert.doesNotMatch(await status.innerText(),/成绩已记录/);
        await clickTwice(retry);
        await status.getByRole('button',{name:'再练一次'}).waitFor();
        assert.equal(sends.length,2,'expected one failed delivery and one retry');assert.equal(receipts.size,1);
        assert.deepEqual(sends[0],sends[1]); assert.equal([...receipts.values()][0].result.score,17);
        assert.match(await status.innerText(),/17\s*\/\s*20|(?:首次|首答)[^。]*17/);
        assert.equal(await page.locator('#wrongQuestionsContainer li').count(),3);
        const events=await page.evaluate(()=>window.qaEvents);
        assert.equal(events.filter(e=>e.type==='score-submitted').length,1);
        assert.deepEqual(events.filter(e=>e.type==='mistakes-recorded').map(e=>e.detail.count),[3]);
        if(touch) assert.equal(await page.evaluate(()=>window.qaNativeEditorFocus),0);
        return {viewport,checks:'vertical place alignment while typing/deleting/correcting; full round, 17/20 and 3 corrected, lost-response retry',rounds:begins,syntheticPosts:sends.length};
    } finally {
        await context.close();
        assert.deepEqual([...errors,...unexpected], [],'uncaught error / invalid or unexpected request');
    }
}
(async()=>{
    const html=await readGame(), {chromium}=getPlaywright();
    const systemChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const executablePath=process.env.CHROME_PATH || (!fs.existsSync(chromium.executablePath()) && fs.existsSync(systemChrome) ? systemChrome : undefined);
    const browser=await chromium.launch({headless:true,executablePath});
    try {
        const results=await Promise.all([[390,844],[1280,844],[320,700],[768,1024]].map(([width,height])=>verify(html,browser,{width,height})));
        console.log(JSON.stringify({source:isProduction?'production-static':'local',sha256:createHash('sha256').update(html).digest('hex'),results},null,2));
    } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
