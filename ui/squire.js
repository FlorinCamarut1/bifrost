// Sir Bodo, the squire at the bottom of the sidebar: a bucket helmet too big for him, a wooden sword and an opinion
// about everything. Click him for a line; he also comments on syncs, PLAY and errors (window.squire.say(kind)).
// Settings → Sir Bodo hides him (G.squire).
(function () {
  const L = (ro, en) => (((typeof S !== 'undefined' && S.settings?.lang) || 'en') === 'en' ? en : ro);   // (S: app.js's state)
  const LINES = {
    idle: [
      ['Sir Bodo, scutier de serviciu. Sabia e de lemn, curajul e adevărat.', 'Sir Bodo, squire on duty. The sword is wooden, the courage is real.'],
      ['Am lustruit coiful de trei ori. Tot nu văd nimic prin el.', 'Polished the helmet three times. Still can\'t see a thing through it.'],
      ['Un dragon mi-a cerut parola de la Wi-Fi. I-am zis că e „Odin123”.', 'A dragon asked me for the Wi-Fi password. I told him it\'s "Odin123".'],
      ['Nu mă mai împunge, milord. Armura e închiriată.', 'Stop poking me, my lord. The armour is rented.'],
      ['Pe vremea mea, modurile veneau cu porumbelul. Și jumătate se pierdeau.', 'In my day mods came by carrier pigeon. Half of them got lost.'],
      ['Calul meu e la potcovit. Merg pe jos până la server.', 'My horse is at the blacksmith. I\'m walking to the server.'],
      ['Bifrost? Eu îi zic „podul curcubeu cu internet”.', 'Bifrost? I call it "the rainbow bridge with internet".'],
      ['Dacă vezi un troll, nu-l hrăni. Mai ales cu moduri vechi.', 'If you see a troll, don\'t feed it. Especially not outdated mods.'],
      ['Am făcut antrenament cu sabia toată dimineața. Gardul a câștigat.', 'Sword practice all morning. The fence won.'],
      ['Mama zicea să mă fac cavaler. Tata zicea să mă fac IT-ist. Uite-mă aici, la mijloc.', 'Mum said become a knight. Dad said go into IT. And here I am, right in between.'],
      ['Coiful ăsta e moștenire de familie. Bunicul încă e în el undeva.', 'This helmet is a family heirloom. Grandpa is still in there somewhere.'],
      ['Scutul are o rună pe el. Nu știu ce înseamnă, dar arată bine.', 'The shield has a rune on it. No idea what it means, but it looks good.'],
      ['Shhh... ascult serverul. Sună a „încă un mod”.', 'Shhh... I\'m listening to the server. It sounds like "one more mod".'],
    ],
    sync: [
      ['Încarc căruța cu moduri! Hăi, căluțule!', 'Loading the cart with mods! Giddy up!'],
      ['Car moduri la server. Nu mă grăbi, sunt grele.', 'Hauling mods to the server. Don\'t rush me, they\'re heavy.'],
    ],
    done: [
      ['Livrat! Și n-am scăpat nimic pe drum. Cred.', 'Delivered! Didn\'t drop a thing on the way. I think.'],
      ['Gata, milord. Serverul a semnat de primire.', 'Done, my lord. The server signed for it.'],
    ],
    error: [
      ['Pe barba lui Odin! Ceva s-a stricat.', 'By Odin\'s beard! Something broke.'],
      ['N-am fost eu. Era deja așa când am venit.', 'Wasn\'t me. It was like that when I got here.'],
      ['Aoleu. Chem fierarul?', 'Oh dear. Shall I fetch the blacksmith?'],
    ],
    play: [
      ['La arme! Și la gustări!', 'To arms! And to snacks!'],
      ['Mergi, milord! Eu păzesc castelul. Și frigiderul.', 'Go, my lord! I\'ll guard the castle. And the fridge.'],
    ],
    join: [
      ['Vine cineva pe pod! Să scot berea?', 'Someone\'s crossing the bridge! Shall I fetch the ale?'],
    ],
  };
  const svg = `<svg viewBox="0 0 64 78" aria-hidden="true">
    <ellipse cx="32" cy="74" rx="15" ry="2.6" fill="#000" opacity=".35"/>
    <g class="sq-body">
      <rect x="24" y="58" width="6" height="11" rx="2" fill="#5a3b22"/><rect x="34" y="58" width="6" height="11" rx="2" fill="#5a3b22"/>
      <rect x="21.5" y="67" width="9.5" height="4.5" rx="2.2" fill="#2b1d12"/><rect x="33" y="67" width="9.5" height="4.5" rx="2.2" fill="#2b1d12"/>
      <path d="M21 41 Q32 35 43 41 L45.5 60 Q32 64 18.5 60 Z" fill="#2f5aa8"/>
      <path d="M26 39 L32 46 L38 39" fill="none" stroke="#f4dfa6" stroke-width="1.6"/>
      <rect x="19.5" y="52" width="25" height="3.2" fill="#6b4423"/><rect x="30" y="51.2" width="4.4" height="4.8" rx="1" fill="#e6c477"/>
      <path d="M42 42 Q49 43 52 48" fill="none" stroke="#2f5aa8" stroke-width="5" stroke-linecap="round"/>
      <g class="sq-sword">
        <rect x="51" y="17" width="4.4" height="27" rx="1.6" fill="#c9a26b" stroke="#8a6638" stroke-width=".8"/>
        <rect x="47.2" y="43" width="12" height="3.2" rx="1.4" fill="#8a6638"/>
        <rect x="51.9" y="46" width="2.6" height="5.5" fill="#5a3b22"/>
        <circle cx="53.2" cy="50" r="3.4" fill="#f1c9a0"/>
      </g>
      <g class="sq-shield">
        <circle cx="17" cy="49" r="9.5" fill="#8a5a2b" stroke="#e6c477" stroke-width="2"/>
        <path d="M17 55 V43 M17 47.5 L13 43 M17 47.5 L21 43" fill="none" stroke="#f4dfa6" stroke-width="1.7" stroke-linecap="round"/>
      </g>
      <g class="sq-head">
        <path class="sq-plume" d="M33 9 C36 1 46 -1 52 4 C46 4 41 6 37 11 Z" fill="#d9534f"/>
        <path d="M13 22 Q13 8 32 8 Q51 8 51 22 L51 36 Q32 40 13 36 Z" fill="#aeb8cc" stroke="#6f7a92" stroke-width="1.2"/>
        <path d="M32 9 V20" stroke="#6f7a92" stroke-width="1.4"/>
        <rect x="17" y="21" width="30" height="5" rx="2" fill="#0b1020"/>
        <g class="sq-eyes"><circle cx="26" cy="23.5" r="1.4" fill="#f4dfa6"/><circle cx="38" cy="23.5" r="1.4" fill="#f4dfa6"/></g>
        <g fill="#6f7a92"><circle cx="24" cy="31" r=".9"/><circle cx="28" cy="32" r=".9"/><circle cx="32" cy="32.3" r=".9"/><circle cx="36" cy="32" r=".9"/><circle cx="40" cy="31" r=".9"/></g>
        <circle cx="16" cy="28" r="1" fill="#e6c477"/><circle cx="48" cy="28" r="1" fill="#e6c477"/>
      </g>
    </g>
  </svg>`;

  let el, bubble, hideT, lastIdle = -1, lastSaidAt = 0;
  function mount() {
    const foot = document.querySelector('.sidebar-foot');
    if (!foot || document.getElementById('squire')) return;
    el = document.createElement('div');
    el.id = 'squire'; el.className = 'squire';
    el.innerHTML = `<div class="sq-bubble" hidden></div><button class="sq-btn" title="Sir Bodo">${svg}</button>`;
    foot.prepend(el);
    bubble = el.querySelector('.sq-bubble');
    el.querySelector('.sq-btn').addEventListener('click', () => { hop(); say('idle', true); });
    // he blinks now and then (the eyes in the helmet slit)
    (function blink() { setTimeout(() => { el.classList.add('blink'); setTimeout(() => el.classList.remove('blink'), 160); blink(); }, 2500 + Math.random() * 4500); })();
  }
  function hop() { el.classList.remove('hop'); void el.offsetWidth; el.classList.add('hop'); }
  function pick(kind) {
    const list = LINES[kind] || LINES.idle;
    let i = Math.floor(Math.random() * list.length);
    if (kind === 'idle' && list.length > 1 && i === lastIdle) i = (i + 1) % list.length;
    if (kind === 'idle') lastIdle = i;
    return L(...list[i]);
  }
  // events speak at most every 20 s (a burst of errors should not turn him into a chatterbox); clicks always do
  function say(kind = 'idle', force = false) {
    if (!el || el.hidden) return;
    if (!force && Date.now() - lastSaidAt < 20000) return;
    lastSaidAt = Date.now();
    bubble.textContent = pick(kind); bubble.hidden = false;
    el.dataset.mood = kind;
    clearTimeout(hideT);
    hideT = setTimeout(() => { bubble.hidden = true; el.dataset.mood = ''; }, 6500);
  }
  function show(on) { if (el) { el.hidden = !on; if (!on) bubble.hidden = true; } }
  window.squire = { mount, say, show };
})();
