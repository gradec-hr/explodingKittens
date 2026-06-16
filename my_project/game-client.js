/**
 * game-client.js
 * Connects the Exploding Kittens frontend to the Node.js backend via Socket.io.
 */

// ─── Session data (set by lobby.html before redirect) ─────────────────────────
const MY_USER_ID  = parseInt(sessionStorage.getItem('userId') || '0');
const MY_USERNAME = sessionStorage.getItem('username') || 'You';
const GAME_ID     = parseInt(sessionStorage.getItem('gameId') || '0');

if (!MY_USER_ID || !GAME_ID) {
  window.location.href = '/lobby.html';
}

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io();

// ─── Audio ────────────────────────────────────────────────────────────────────
class AudioController {
  constructor() {
    this.yourTurnSound      = new Audio('assets/audio/your-turn.mp3');
    this.wickSoundEffect    = new Audio('assets/audio/wick.mp3');
    this.shuffleSoundEffect = new Audio('assets/audio/shuffle.mp3');
    this.shoutSound         = new Audio('assets/audio/shout.mp3');
    this.pickOrDrawSound    = new Audio('assets/audio/pick-a-card.mp3');
    this.miauSoundEffect    = new Audio('assets/audio/miau.mp3');
    this.iExplodedSound     = new Audio('assets/audio/I-exploded.mp3');
    this.finalSound         = new Audio('assets/audio/final.mp3');
    this.moveSoundEffect    = new Audio('assets/audio/move.mp3');
    this.bgMusic            = new Audio('assets/audio/ambience.mp3');

    this.bgMusic.volume = 0.02;
    this.bgMusic.loop   = true;
    this.wickSoundEffect.playbackRate = 0.8;
  }
  startMusic()     { this.bgMusic.play().catch(() => {}); }
  stopMusic()      { this.bgMusic.pause(); this.bgMusic.currentTime = 0; }
  pickACardSound() { this.pickOrDrawSound.play().catch(() => {}); }
  dyingSound()     { this.shoutSound.play().catch(() => {}); }
  explosionSound() { this.iExplodedSound.play().catch(() => {}); }
  miauSound()      { this.miauSoundEffect.play().catch(() => {}); }
  moveSound()      { this.moveSoundEffect.play().catch(() => {}); }
  shuffleSound()   { this.shuffleSoundEffect.play().catch(() => {}); }
  wickSound()      { this.wickSoundEffect.play().catch(() => {}); }
  wickSoundStop()  { this.wickSoundEffect.pause(); }
  finalMusic()     { this.stopMusic(); this.finalSound.play().catch(() => {}); }
  yourTurnAlert()  { this.yourTurnSound.play().catch(() => {}); }
}

const audio = new AudioController();

// ─── Global game state ────────────────────────────────────────────────────────
let gameState   = null;
let myHand      = [];
let pendingBomb = null;

// Pair-mode state
let pairModeActive   = false;
let pairFirstCardId  = null;
let pairEscHandler   = null;

// Active nope window
let activePendingId  = null;
let countdownAnim    = null;   // CSS animation restart handle

// Track previous current-player so "Your Turn" only fires once per turn switch
let lastCurrentPlayerId = null;

// ─── Avatar list for opponents ────────────────────────────────────────────────
const OPPONENT_AVATARS = [
  'assets/images/user2.png',
  'assets/images/user3.png',
  'assets/images/user4.png',
  'assets/images/user5.png',
];

// ─── Initialise ───────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  audio.startMusic();
  setupDeckClick();

  // Exit / leave game button (the button inside .logout-button)
  document.querySelector('.exit-game-btn')?.addEventListener('click', () => {
    if (!confirm('Leave the game? You will be eliminated!')) return;
    socket.emit('leave-game', { gameId: GAME_ID });
  });

  // Card click/drag is set up in renderMyHand() once cards arrive from server
});

socket.on('connect', () => {
  socket.emit('join-lobby', { gameId: GAME_ID });
});

// ─── Socket events ────────────────────────────────────────────────────────────

socket.on('game-start', (state) => {
  console.log('game-start', state);
  updateState(state);
});

socket.on('game-state', (state) => {
  console.log('game-state', state);
  updateState(state);
});

socket.on('opponent-drew-card', ({ userId, username, isBomb }) => {
  if (isBomb) {
    audio.wickSound();
    showOpponentBomb(userId);   // pulsing kitten icon on their avatar
    // Don't add a card-back; the bomb goes into their hand but the server
    // will correct the card count via the next game-state push anyway.
  } else {
    audio.pickACardSound();
    opponentPickCard(userId);
  }
});

socket.on('card-drawn', ({ card, state }) => {
  audio.pickACardSound();
  addCardToMyHand(card);
  updateState(state);  // "Your Turn" handled inside updateState via lastCurrentPlayerId check
});

socket.on('bomb-drawn', ({ cardId }) => {
  pendingBomb = cardId;
  audio.wickSound();
  showBombDefuseUI(cardId);
});

// ── Pending / Nope ────────────────────────────────────────────────────────────

socket.on('action-pending', ({ pendingId, card, card2, userId, username, targetUserId, targetUsername, isPair }) => {
  activePendingId = pendingId;
  audio.pickACardSound();

  // Animate card flying from opponent to discard pile
  if (userId !== MY_USER_ID) {
    const opponentDiv = getOpponentDivByUserId(userId);
    if (opponentDiv) flyCardToDiscard(opponentDiv, card.card_image);
    // Remove one small-card visually (will be corrected by next game-state)
    const c = opponentDiv ? opponentDiv.querySelector('.small-card') : null;
    if (c) c.remove();
  }

  // Show card played on table
  showTableAction(card, userId, username, targetUserId, targetUsername, isPair ? 'PAIR STEAL' : null);

  // Show nope countdown
  showNopeCountdown(pendingId);
});

socket.on('action-noped', ({ pendingId, nopeUsername, nopeCount, isNoped }) => {
  if (pendingId !== activePendingId) return;
  showToast(`${nopeUsername.toUpperCase()} NOPED! (${nopeCount}x) → ${isNoped ? 'CANCELLED' : 'GOING THROUGH!'}`);

  // Restart arc animation
  restartCountdownArc(isNoped);
  updateNopeCount(nopeCount, isNoped);
});

socket.on('action-resolved', ({ pendingId }) => {
  if (pendingId === activePendingId) hideNopeCountdown();
});

socket.on('action-cancelled', ({ pendingId }) => {
  if (pendingId === activePendingId) {
    hideNopeCountdown();
    showToast('ACTION NOPED!');
  }
});

// ── Card played ───────────────────────────────────────────────────────────────

socket.on('card-played', ({ event, card, card2, userId, username, targetUserId, targetUsername, top3, stolenCard }) => {
  hideNopeCountdown();
  hideFavorWaiting();
  handleCardPlayedResult(event, card, userId, username, targetUserId, targetUsername, top3, stolenCard);
});

// ── Favor ─────────────────────────────────────────────────────────────────────

socket.on('favor-request', ({ favorId, requesterId, requesterUsername, hand }) => {
  showFavorResponseUI(favorId, requesterUsername, hand);
});

socket.on('favor-waiting', ({ favorId, requesterId, requesterUsername, targetUserId, targetUsername }) => {
  showFavorWaiting(requesterUsername, targetUsername);
});

// ── Bomb / defuse ─────────────────────────────────────────────────────────────

socket.on('bomb-defused', ({ userId, username }) => {
  audio.miauSound();
  pendingBomb = null;
  hideBombDefuseUI();
  clearOpponentBomb(userId);   // remove pulsing kitten icon
  showTableAction({ card_image: 'cards/defuse1.png', card_type: 'defuse' }, userId, username, null, null, 'DEFUSED');
});

socket.on('player-died', ({ userId, username }) => {
  audio.dyingSound();
  clearOpponentBomb(userId);   // remove kitten icon before markPlayerDead overwrites avatar
  markPlayerDead(userId);
  showTableAction({ card_image: 'explodingkitten.png', card_type: 'exploding' }, userId, username, null, null, 'EXPLODED');
});

socket.on('game-over', ({ winnerId, winnerUsername }) => {
  audio.finalMusic();
  showVictoryScreen(winnerId === MY_USER_ID, winnerUsername, winnerId);
});

socket.on('error', (msg) => {
  console.warn('Server error:', msg);
  showToast(msg);
});

// Server confirms we successfully left — navigate back to lobby
socket.on('left-game', () => {
  window.location.href = '/lobby.html';
});

// ─── State update ─────────────────────────────────────────────────────────────

function updateState(state) {
  gameState = state;
  if (state.myHand) {
    myHand = state.myHand;
    renderMyHand();
  }
  renderOpponents(state.players);
  updateDeckCounter(state.deckSize);
  updateDiscardPile(state.discardTop);
  highlightCurrentPlayer(state.currentPlayerId);
  updateTableInfo(state);
  const isMyTurn = state.currentPlayerId === MY_USER_ID;
  setDeckInteractive(isMyTurn);
  // Only show "Your Turn" when the turn actually switches to me (not on every state push)
  if (isMyTurn && lastCurrentPlayerId !== MY_USER_ID) {
    showYourTurn(true);
  }
  lastCurrentPlayerId = state.currentPlayerId;
}

// ─── Render my hand ───────────────────────────────────────────────────────────

function renderMyHand() {
  const container = document.getElementById('myContainer');
  container.innerHTML = '';
  myHand.forEach(card => {
    const img = document.createElement('img');
    img.src = `assets/images/${card.card_image}`;
    img.id  = card.card_type;
    img.dataset.cardId    = card.card_id;
    img.dataset.cardImage = card.card_image;
    img.classList.add('card-front');
    img.setAttribute('draggable', 'true');
    container.appendChild(img);
  });
  placeTheCardsOfEachPlayer();
  hoverOverMyCardsEffect();
  setupCardClicks();   // click-to-play
  setupDragging();     // hand reordering only
}

// ─── Render opponents ─────────────────────────────────────────────────────────

function renderOpponents(players) {
  const container = document.getElementById('opponents-container');
  const opponents  = players.filter(p => p.userId !== MY_USER_ID);

  const myNameEl = document.querySelector('.my-name');
  if (myNameEl) myNameEl.textContent = MY_USERNAME.toUpperCase();

  // Preserve existing divs by userId, add/remove as needed
  const existingDivs = new Map(
    [...container.querySelectorAll('.opponent')].map(d => [parseInt(d.dataset.userId), d])
  );
  const incomingIds = new Set(opponents.map(p => p.userId));

  existingDivs.forEach((div, uid) => { if (!incomingIds.has(uid)) div.remove(); });

  opponents.forEach((player, i) => {
    let div = existingDivs.get(player.userId);

    if (!div) {
      div = document.createElement('div');
      div.className = 'opponent';
      div.dataset.userId = player.userId;

      const nameEl = document.createElement('div');
      nameEl.className = 'opponent-name';

      const logoContainer = document.createElement('div');
      logoContainer.className = 'user-logo-container';
      const logo = document.createElement('img');
      logo.className = 'user-logo';
      logoContainer.appendChild(logo);

      const cardsEl = document.createElement('div');
      cardsEl.className = 'opponent-cards';

      div.appendChild(nameEl);
      div.appendChild(logoContainer);
      div.appendChild(cardsEl);
      container.appendChild(div);
    }

    div.querySelector('.opponent-name').textContent = player.username.toUpperCase();

    const logo = div.querySelector('.user-logo');
    if (logo) {
      logo.src = player.isAlive
        ? OPPONENT_AVATARS[i % OPPONENT_AVATARS.length]
        : 'assets/images/userDead.png';
      logo.classList.toggle('user-dead', !player.isAlive);
    }

    // Sync card-back count
    const cardsEl = div.querySelector('.opponent-cards');
    if (cardsEl) {
      const current = cardsEl.querySelectorAll('.small-card').length;
      const target  = player.cardCount;
      for (let j = current; j < target; j++) {
        const img = document.createElement('img');
        img.src = 'assets/images/cardback.png';
        img.className = 'small-card';
        cardsEl.appendChild(img);
      }
      for (let j = 0; j < current - target; j++) {
        cardsEl.querySelector('.small-card')?.remove();
      }
    }
  });

  placeTheCardsOfEachPlayer();
}

// ─── Deck ─────────────────────────────────────────────────────────────────────

function setupDeckClick() {
  const deck = document.querySelector('.deck-block');
  if (!deck) return;
  deck.addEventListener('click', () => {
    if (pairModeActive) return;
    if (!gameState || gameState.currentPlayerId !== MY_USER_ID) return;
    socket.emit('draw-card', { gameId: GAME_ID });
  });
}

function setDeckInteractive(interactive) {
  const deck = document.querySelector('.deck-block');
  if (deck) deck.style.opacity = interactive ? '1' : '0.5';
}

function updateDeckCounter(size) {
  const el = document.querySelector('.counter-cards');
  if (el) el.textContent = size;
}

function updateDiscardPile(topCard) {
  if (!topCard) return;
  const pile = document.querySelector('.discard-pile');
  if (!pile) return;
  let topImg = pile.querySelector('.card-on-table:not(.text-place-cards)');
  if (!topImg) {
    topImg = document.createElement('img');
    topImg.classList.add('card-on-table');
    pile.prepend(topImg);
  }
  topImg.src = `assets/images/${topCard.card_image}`;
}

// ─── Click-to-play ────────────────────────────────────────────────────────────
// Clicking a card in your hand plays it directly (no drag needed).

function setupCardClicks() {
  const container = document.getElementById('myContainer');
  if (!container) return;
  container.querySelectorAll('.card-front').forEach(card => {
    // Remove any previous listener by cloning (safest approach on re-render)
    card.addEventListener('click', onCardClick);
  });
}

function onCardClick(e) {
  const cardEl    = e.currentTarget;
  const cardId    = parseInt(cardEl.dataset.cardId);
  const cardType  = cardEl.id;
  const cardImage = cardEl.dataset.cardImage;

  // Pair mode — pair selection is handled by enterPairMode's own listeners
  if (pairModeActive) return;

  // Any player can play a Nope during an active pending action
  if (activePendingId !== null && cardType === 'nope') {
    socket.emit('play-nope', { gameId: GAME_ID, pendingId: activePendingId, nopeCardId: cardId });
    return;
  }

  // Only the current player can play other cards
  if (!gameState || gameState.currentPlayerId !== MY_USER_ID) return;

  // Steal cards need a matching pair
  if (cardType === 'steal') {
    const matches = myHand.filter(c => c.card_image === cardImage && c.card_id !== cardId);
    if (matches.length === 0) {
      showToast('YOU NEED A MATCHING PAIR!');
      return;
    }
    enterPairMode(cardId, cardImage, matches);
    return;
  }

  // Favor needs a target
  if (cardType === 'favor') {
    pickTargetPlayer().then(targetUserId => {
      if (targetUserId) socket.emit('play-card', { gameId: GAME_ID, cardId, targetUserId });
    });
    return;
  }

  // Everything else: play immediately
  socket.emit('play-card', { gameId: GAME_ID, cardId });
}

// Keep drag only for hand reordering (no discard-pile drop)
function setupDragging() {
  const container = document.getElementById('myContainer');
  if (!container) return;

  let draggingCard = null;

  container.querySelectorAll('.card-front').forEach(card => {
    card.addEventListener('dragstart', () => { draggingCard = card; card.classList.add('dragging'); });
    card.addEventListener('dragend',   () => { card.classList.remove('dragging'); draggingCard = null; });
  });

  container.addEventListener('dragover', e => {
    e.preventDefault();
    const afterEl   = getDragAfterElement(container, e.clientX);
    const draggable = container.querySelector('.dragging');
    if (!draggable) return;
    if (afterEl == null) container.appendChild(draggable);
    else container.insertBefore(draggable, afterEl);
  });
}

function getDragAfterElement(container, x) {
  const els = [...container.querySelectorAll('.card-front:not(.dragging)')];
  return els.reduce((closest, el) => {
    const box    = el.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: el };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ─── Pair-mode (steal cards) ──────────────────────────────────────────────────

function enterPairMode(firstCardId, cardImage, matches) {
  pairModeActive  = true;
  pairFirstCardId = firstCardId;

  const container = document.getElementById('myContainer');
  const allCards  = container.querySelectorAll('.card-front');

  allCards.forEach(card => {
    const cid    = parseInt(card.dataset.cardId);
    const isMatch = matches.some(m => m.card_id === cid);
    const isFirst = cid === firstCardId;
    card.classList.toggle('pair-selectable', isMatch);
    card.classList.toggle('pair-dim',        !isMatch && !isFirst);
    if (isMatch) card.style.cursor = 'pointer';
  });

  showToast('SELECT THE MATCHING CARD (ESC to cancel)');

  matches.forEach(matchCard => {
    const cardEl = container.querySelector(`[data-card-id="${matchCard.card_id}"]`);
    if (!cardEl) return;
    cardEl.addEventListener('click', function onPairClick() {
      cardEl.removeEventListener('click', onPairClick);
      exitPairMode();
      pickTargetPlayer().then(targetUserId => {
        if (targetUserId) {
          socket.emit('play-pair', {
            gameId: GAME_ID,
            cardId1: firstCardId,
            cardId2: matchCard.card_id,
            targetUserId,
          });
        }
      });
    });
  });

  pairEscHandler = (e) => {
    if (e.key === 'Escape') exitPairMode();
  };
  document.addEventListener('keydown', pairEscHandler);
}

function exitPairMode() {
  pairModeActive = false;
  pairFirstCardId = null;
  if (pairEscHandler) {
    document.removeEventListener('keydown', pairEscHandler);
    pairEscHandler = null;
  }
  const container = document.getElementById('myContainer');
  if (!container) return;
  container.querySelectorAll('.card-front').forEach(card => {
    card.classList.remove('pair-selectable', 'pair-dim');
    card.style.cursor = '';
  });
}

// ─── Bomb defuse UI ───────────────────────────────────────────────────────────

function showBombDefuseUI(bombCardId) {
  createOverlayExplodingKittenDefuse();
  placeTheCardsDefuse();
  hoverOverMyDefuseCardsEffect();

  // Activate a defuse card (via drop or click) → pick a deck position.
  const activateDefuse = card => {
    if (!card || card.id !== 'defuse') return;
    hideBombDefuseUI();
    showDeckPositionPicker(bombCardId, parseInt(card.dataset.cardId));
  };

  const container = document.querySelector('.img-defuse-container');
  if (container) {
    container.addEventListener('dragover', e => e.preventDefault());
    container.addEventListener('drop', () => {
      activateDefuse(document.querySelector('#defuseContainer .dragging'));
    });
  }

  // Click a defuse card to activate it directly (no drag required).
  document.querySelectorAll('#defuseContainer .defuse-card').forEach(card => {
    if (card.id !== 'defuse') return;
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => activateDefuse(card));
  });

  var tl = gsap.timeline();
  var distance = 33 * window.innerWidth / 100;
  tl.to('.spark',         { duration: 10, x: -distance, ease: 'power0.out' });
  tl.to('.svg-rectangle', { duration: 10, x: -distance, ease: 'power0.out', delay: -10 });

  setTimeout(() => {
    if (pendingBomb === bombCardId) {
      socket.emit('no-defuse', { gameId: GAME_ID, bombCardId });
      hideBombDefuseUI();
    }
  }, 11000);
}

function hideBombDefuseUI() {
  const el = document.getElementById('exploding-kitten-defuse');
  if (el) el.remove();
}

function showDeckPositionPicker(bombCardId, defuseCardId) {
  const deckSize = gameState ? gameState.deckSize : 5;
  document.getElementById('kitten-defused').classList.add('visible');

  const buttonContainer = document.querySelector('.button-container');
  buttonContainer.innerHTML = '';

  const positions = ['FIRST', 'SECOND', 'THIRD', 'BOTTOM'];
  if (deckSize >= 4) positions.splice(3, 0, 'RANDOM');

  positions.slice(0, Math.min(deckSize + 1, 5)).forEach((label, i) => {
    const btn = document.createElement('button');
    btn.classList.add('button-to-deck', 'button-19');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      let pos = i;
      if (label === 'BOTTOM')  pos = deckSize;
      if (label === 'RANDOM')  pos = Math.floor(Math.random() * deckSize);
      document.getElementById('kitten-defused').classList.remove('visible');
      socket.emit('defuse-bomb', { gameId: GAME_ID, defuseCardId, bombCardId, deckPosition: pos });
    });
    buttonContainer.appendChild(btn);
  });
}

// ─── Nope countdown UI ────────────────────────────────────────────────────────

function showNopeCountdown(pendingId) {
  const el = document.getElementById('nope-countdown');
  if (!el) return;
  el.style.display = 'flex';

  // Reset & restart arc animation
  const arc = document.getElementById('countdown-arc');
  if (arc) {
    arc.classList.remove('noped');
    arc.style.animation = 'none';
    // Force reflow to restart CSS animation
    void arc.offsetWidth;
    arc.style.animation = `countdown5s ${NOPE_WINDOW_MS / 1000}s linear forwards`;
  }

  // Set up nope-zone drop target
  setupNopeZoneDrop(pendingId);
}

const NOPE_WINDOW_MS = 5000;

function hideNopeCountdown() {
  const el = document.getElementById('nope-countdown');
  if (el) el.style.display = 'none';
  activePendingId = null;

  const arc = document.getElementById('countdown-arc');
  if (arc) arc.style.animation = 'none';

  // Remove nope-zone listeners by replacing element
  const zone = document.getElementById('nope-zone');
  if (zone) {
    const fresh = zone.cloneNode(true);
    zone.parentNode.replaceChild(fresh, zone);
  }
}

function restartCountdownArc(isNoped) {
  const arc = document.getElementById('countdown-arc');
  if (!arc) return;
  arc.classList.toggle('noped', isNoped);
  arc.style.animation = 'none';
  void arc.offsetWidth;
  arc.style.animation = `countdown5s ${NOPE_WINDOW_MS / 1000}s linear forwards`;
}

function updateNopeCount(count, isNoped) {
  const el = document.getElementById('nope-count');
  if (el) el.textContent = count > 0 ? `${count}× ${isNoped ? '🚫' : '✅'}` : '';
}

function setupNopeZoneDrop(pendingId) {
  const zone = document.getElementById('nope-zone');
  if (!zone) return;

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', () => {
    zone.classList.remove('drag-over');
    // Find dragged nope card
    const draggingCard = document.querySelector('.card-front.dragging');
    if (!draggingCard) return;
    const cardType = draggingCard.id;
    const cardId   = parseInt(draggingCard.dataset.cardId);
    if (cardType !== 'nope') {
      showToast('ONLY NOPE CARDS CAN BE DRAGGED HERE!');
      return;
    }
    socket.emit('play-nope', { gameId: GAME_ID, pendingId, nopeCardId: cardId });
  });
}

// ─── Favor UI ─────────────────────────────────────────────────────────────────

function showFavorResponseUI(favorId, requesterUsername, hand) {
  const overlay = document.createElement('div');
  overlay.id = 'favor-overlay';
  overlay.className = 'favor-overlay';

  const title = document.createElement('div');
  title.className = 'favor-title';
  title.textContent = `${requesterUsername.toUpperCase()} WANTS A CARD FROM YOU`;

  const sub = document.createElement('div');
  sub.className = 'favor-subtitle';
  sub.textContent = 'Click the card you want to give:';

  const cardsContainer = document.createElement('div');
  cardsContainer.className = 'favor-cards-container';

  hand.forEach(card => {
    const img = document.createElement('img');
    img.src       = `assets/images/${card.card_image}`;
    img.className = 'favor-card';
    img.title     = card.card_type;
    img.addEventListener('click', () => {
      overlay.remove();
      socket.emit('favor-response', { favorId, cardId: card.card_id });
    });
    cardsContainer.appendChild(img);
  });

  overlay.appendChild(title);
  overlay.appendChild(sub);
  overlay.appendChild(cardsContainer);
  document.body.appendChild(overlay);
}

function showFavorWaiting(requesterUsername, targetUsername) {
  hideFavorWaiting();
  const el = document.createElement('div');
  el.id = 'favor-waiting-msg';
  el.className = 'favor-waiting-msg';
  el.textContent = `WAITING FOR ${targetUsername.toUpperCase()} TO GIVE A CARD TO ${requesterUsername.toUpperCase()}…`;
  document.body.appendChild(el);
}

function hideFavorWaiting() {
  const el = document.getElementById('favor-waiting-msg');
  if (el) el.remove();
}

// ─── Flying card animation ────────────────────────────────────────────────────

function flyCardToDiscard(fromElement, cardImage) {
  const from    = fromElement.getBoundingClientRect();
  const discardEl = document.querySelector('.discard-pile');
  if (!discardEl) return;
  const to = discardEl.getBoundingClientRect();

  const img = document.createElement('img');
  img.src = `assets/images/${cardImage}`;
  img.className = 'flying-card-anim';
  img.style.left = `${from.left + from.width  / 2 - 40}px`;
  img.style.top  = `${from.top  + from.height / 2 - 40}px`;
  document.body.appendChild(img);

  gsap.to(img, {
    duration: 0.65,
    left: to.left + to.width  / 2 - 40,
    top:  to.top  + to.height / 2 - 40,
    scale: 0.8,
    ease: 'power2.in',
    onComplete: () => img.remove(),
  });
}

// ─── Table info ───────────────────────────────────────────────────────────────

function updateTableInfo(state) {
  const player  = state.players.find(p => p.userId === state.currentPlayerId);
  const isMe    = state.currentPlayerId === MY_USER_ID;
  const playerName = player ? player.username.toUpperCase() : '—';

  // Avatar
  const avatar = document.getElementById('user-playing-table');
  if (avatar) {
    if (isMe) {
      avatar.src = 'assets/images/user1.png';
    } else {
      const idx = state.players.filter(p => p.userId !== MY_USER_ID)
                               .findIndex(p => p.userId === state.currentPlayerId);
      avatar.src = OPPONENT_AVATARS[Math.max(idx, 0) % OPPONENT_AVATARS.length];
    }
  }

  // Name / turn label
  const nameEl = document.getElementById('table-player-name');
  if (nameEl) nameEl.textContent = isMe ? "YOUR TURN" : `${playerName}'S TURN`;

  // Draws owed
  const drawsEl = document.getElementById('table-draws-text');
  if (drawsEl) {
    const n = state.movesToPlay || 1;
    drawsEl.textContent = `MUST DRAW: ${n}`;
  }
}

function showTableAction(card, userId, username, targetUserId, targetUsername, overrideName) {
  const isMe = userId === MY_USER_ID;
  const displayName = overrideName || card.card_type.toUpperCase();

  const cardImg  = document.getElementById('table-action-card');
  const cardName = document.getElementById('table-action-name');
  const targetRow  = document.getElementById('table-target-row');
  const targetNameEl = document.getElementById('table-target-name');

  if (cardImg)  { cardImg.src = `assets/images/${card.card_image}`; cardImg.style.visibility = 'visible'; }
  if (cardName) cardName.textContent = displayName;

  if (targetUserId && targetNameEl && targetRow) {
    targetNameEl.textContent = (targetUsername || '').toUpperCase();
    targetRow.style.visibility = 'visible';
  } else if (targetRow) {
    targetRow.style.visibility = 'hidden';
  }
}

// ─── Handle card-played result ────────────────────────────────────────────────

function handleCardPlayedResult(event, card, userId, username, targetUserId, targetUsername, top3, stolenCard) {
  if (event === 'shuffle') audio.shuffleSound();
  audio.pickACardSound();

  showTableAction(card, userId, username, targetUserId, targetUsername);

  if (event === 'see-the-future' && userId === MY_USER_ID && top3) {
    seeTheFutureUI(top3);
  }

  placeTheCardsOfEachPlayer();
}

// ─── Opponent animations ──────────────────────────────────────────────────────

function addCardToMyHand(card) {
  const container = document.getElementById('myContainer');
  const img = document.createElement('img');
  img.src   = `assets/images/${card.card_image}`;
  img.id    = card.card_type;
  img.dataset.cardId    = card.card_id;
  img.dataset.cardImage = card.card_image;
  img.classList.add('card-front');
  img.setAttribute('draggable', 'true');
  container.appendChild(img);
  placeTheCardsOfEachPlayer();
  hoverOverMyCardsEffect();
  setupCardClicks();   // click-to-play
  setupDragging();     // hand reordering only
}

function opponentPickCard(userId) {
  const opponent = getOpponentDivByUserId(userId);
  if (!opponent) return;
  const cardsContainer = opponent.querySelector('.opponent-cards');
  if (!cardsContainer) return;
  const img = document.createElement('img');
  img.src = 'assets/images/cardback.png';
  img.classList.add('small-card');
  cardsContainer.appendChild(img);
  placeTheCardsOfEachPlayer();
}

function markPlayerDead(userId) {
  if (userId === MY_USER_ID) return;
  const div = getOpponentDivByUserId(userId);
  if (!div) return;
  const logo = div.querySelector('.user-logo');
  if (logo) logo.src = 'assets/images/userDead.png';

  const fire = document.createElement('img');
  fire.src = 'assets/images/fire3.gif';
  fire.className = 'fire';
  div.appendChild(fire);

  const explosion = document.createElement('img');
  explosion.src = 'assets/images/explosion2.gif';
  explosion.className = 'explosion';
  div.appendChild(explosion);
}

function getOpponentDivByUserId(userId) {
  const divs = document.querySelectorAll('#opponents-container .opponent');
  for (const div of divs) {
    if (parseInt(div.dataset.userId) === userId) return div;
  }
  return null;
}

/** Show a pulsing exploding-kitten icon over an opponent's avatar when they draw a bomb. */
function showOpponentBomb(userId) {
  const div = getOpponentDivByUserId(userId);
  if (!div) return;
  if (div.querySelector('.bomb-warning')) return;   // already showing
  const img = document.createElement('img');
  img.src = 'assets/images/explodingkitten.png';
  img.className = 'bomb-warning';
  div.appendChild(img);
}

/** Remove the pulsing bomb icon (called on defuse or death). */
function clearOpponentBomb(userId) {
  const div = getOpponentDivByUserId(userId);
  if (!div) return;
  div.querySelector('.bomb-warning')?.remove();
}

function highlightCurrentPlayer(currentPlayerId) {
  document.querySelectorAll('.opponent').forEach(div => {
    const isActive = parseInt(div.dataset.userId) === currentPlayerId;
    div.classList.toggle('active-player', isActive);
  });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function showYourTurn(isMyTurn) {
  const el = document.getElementById('your-turn-image');
  if (!el) return;
  if (isMyTurn) {
    audio.yourTurnAlert();
    el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 3000);
  }
}

function showToast(msg) {
  const existing = document.querySelector('.toast-msg');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className   = 'toast-msg';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function showVictoryScreen(iWon, winnerUsername, winnerId) {
  const overlay = document.getElementById('final-overlay');
  overlay.classList.add('visible');

  // Win / lose headline
  if (iWon) {
    document.querySelector('.victory-text').style.opacity = '1';
  } else {
    const failEl = document.querySelector('.fail-text');
    failEl.style.opacity = '1';
    failEl.textContent = `${winnerUsername.toUpperCase()} WINS!`;
  }

  // Rebuild player list from real game data
  const container = document.getElementById('opponents-container-final');
  if (container && gameState) {
    container.innerHTML = '';
    const allPlayers = gameState.players;   // ordered by orderOfPlay from server

    allPlayers.forEach((player, i) => {
      const isWinner = player.userId === winnerId;
      const isMe     = player.userId === MY_USER_ID;

      const div = document.createElement('div');
      div.className = 'opponent';

      // Name
      const nameEl = document.createElement('div');
      nameEl.className = 'opponent-name';
      nameEl.textContent = player.username.toUpperCase() + (isWinner ? ' 🏆' : '');

      // Avatar + explosion
      const logoContainer = document.createElement('div');
      logoContainer.className = 'user-logo-container';

      const logo = document.createElement('img');
      logo.className = 'user-logo';
      logo.src = isWinner
        ? (isMe ? 'assets/images/user1.png' : `assets/images/${OPPONENT_AVATARS[Math.max(i - (isMe ? 0 : 1), 0) % OPPONENT_AVATARS.length].split('/').pop()}`)
        : 'assets/images/userDead.png';
      logoContainer.appendChild(logo);

      if (!isWinner) {
        const explosion = document.createElement('img');
        explosion.src = 'assets/images/explosion2.gif';
        explosion.className = 'explosion';
        logoContainer.appendChild(explosion);
      }

      div.appendChild(nameEl);
      div.appendChild(logoContainer);
      container.appendChild(div);
    });
  }

  // Wire Back-to-Lobby button (created in HTML)
  const lobbyBtn = document.getElementById('back-to-lobby-btn');
  if (lobbyBtn) {
    lobbyBtn.onclick = () => { window.location.href = '/lobby.html'; };
  }
}

function seeTheFutureUI(top3) {
  const existing = document.querySelector('.overlay-seeTheFuture');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.classList.add('overlay-seeTheFuture');
  const box = document.createElement('div');
  box.classList.add('box-seeTheFuture');

  const btn = document.createElement('button');
  btn.classList.add('red-button-exit');
  const btnImg = document.createElement('img');
  btnImg.src = 'assets/images/red_button.png';
  btnImg.classList.add('red-button-exit-img');
  btn.appendChild(btnImg);
  btn.addEventListener('click', () => { overlay.remove(); box.remove(); });

  const textDiv = document.createElement('div');
  textDiv.textContent = 'SEE THE FUTURE';
  textDiv.classList.add('text-future');

  const container = document.createElement('div');
  container.classList.add('future-container');
  const classes = ['future-card-first', 'future-card-second', 'future-card-third'];
  (top3 || []).forEach((card, i) => {
    const img = document.createElement('img');
    img.src = `assets/images/${card.card_image}`;
    img.classList.add(classes[i] || 'future-card-first');
    container.appendChild(img);
  });

  overlay.appendChild(btn);
  overlay.appendChild(textDiv);
  overlay.appendChild(container);
  document.body.prepend(box);
  document.body.appendChild(overlay);
}

function pickTargetPlayer() {
  return new Promise(resolve => {
    const opponentDivs = document.querySelectorAll('#opponents-container .opponent');
    const handlers = [];

    // Prominent top-centre banner
    const banner = document.createElement('div');
    banner.className = 'pick-opponent-banner';
    banner.textContent = 'PICK AN OPPONENT';
    document.body.appendChild(banner);

    // Small ESC hint
    const cancel = document.createElement('div');
    cancel.className = 'cancel-target';
    cancel.textContent = '👆 CLICK AN OPPONENT  ·  ESC to cancel';
    document.body.appendChild(cancel);

    const cleanup = () => {
      opponentDivs.forEach((d, i) => {
        d.classList.remove('selectable-target');
        if (handlers[i]) d.removeEventListener('click', handlers[i]);
      });
      banner.remove();
      cancel.remove();
      document.removeEventListener('keydown', escHandler);
    };

    opponentDivs.forEach((div, i) => {
      const userId = parseInt(div.dataset.userId);
      if (!userId) return;
      div.classList.add('selectable-target');
      const handler = () => { cleanup(); resolve(userId); };
      handlers[i] = handler;
      div.addEventListener('click', handler);
    });

    const escHandler = (e) => {
      if (e.key === 'Escape') { cleanup(); resolve(null); }
    };
    document.addEventListener('keydown', escHandler);
  });
}

// ─── Reused visual functions ──────────────────────────────────────────────────

function placeTheCardsOfEachPlayer() {
  const cardCount = document.querySelectorAll('.card-front').length;
  const cardWidth = cardCount > 0 ? (document.querySelector('.card-front')?.width || 0) : 0;
  const container = document.getElementById('myContainer');
  if (!container) return;
  const containerWidth = container.offsetWidth;
  if (cardCount > 5) {
    const newCardMargin = parseInt(-Math.floor((cardWidth * cardCount - containerWidth) / cardCount) - 1);
    document.querySelectorAll('.card-front').forEach(card => {
      card.style.marginLeft = newCardMargin + 'px';
    });
  }

  document.querySelectorAll('.opponent-cards').forEach(opponentDeck => {
    const cards = opponentDeck.querySelectorAll('.small-card');
    const count = cards.length;
    const cardW = 20;
    const newMargin = count > 1 ? -Math.floor((cardW * count - 65) / count) - 1 : 0;
    const newRotateAngle = count > 1 ? Math.floor(50 / count) : 0;
    let angle = -25;
    cards.forEach((card, i) => {
      if (i > 0) {
        angle += newRotateAngle;
        if (count > 6) card.style.marginLeft = newMargin + 'px';
        card.style.transform = `rotate(${angle}deg)`;
      }
    });
  });
}

function hoverOverMyCardsEffect() {
  const container = document.getElementById('myContainer');
  if (!container) return;
  container.querySelectorAll('.card-front').forEach(card => {
    if (card.classList.contains('card-on-table')) return;
    const ml = parseInt(window.getComputedStyle(card).marginLeft);
    card.addEventListener('mouseover', () => {
      card.style.transitionDuration = '0.8s';
      card.style.top = '-85px';
      card.style.marginLeft = (ml + 20) + 'px';
      card.style.marginRight = '50px';
    });
    card.addEventListener('mouseout', () => {
      card.style.transitionDuration = '0.5s';
      card.style.top = '0px';
      card.style.marginLeft = ml + 'px';
      card.style.marginRight = '0px';
    });
  });
}

function hoverOverMyDefuseCardsEffect() {
  const container = document.getElementById('defuseContainer');
  if (!container) return;
  container.querySelectorAll('.card-front').forEach(card => {
    const ml = parseInt(window.getComputedStyle(card).marginLeft);
    card.addEventListener('mouseover', () => {
      card.style.transitionDuration = '0.8s';
      card.style.top = '-85px';
      card.style.marginLeft = (ml + 20) + 'px';
      card.style.marginRight = '50px';
    });
    card.addEventListener('mouseout', () => {
      card.style.transitionDuration = '0.5s';
      card.style.top = '0px';
      card.style.marginLeft = ml + 'px';
      card.style.marginRight = '0px';
    });
  });
}

function placeTheCardsDefuse() {
  const container = document.getElementById('defuseContainer');
  if (!container) return;
  myHand.forEach(card => {
    const img = document.createElement('img');
    img.src   = `assets/images/${card.card_image}`;
    img.id    = card.card_type;
    img.dataset.cardId    = card.card_id;
    img.dataset.cardImage = card.card_image;
    img.classList.add('card-front', 'defuse-card');
    img.setAttribute('draggable', 'true');
    container.appendChild(img);
  });
  hoverOverMyDefuseCardsEffect();
}

function createOverlayExplodingKittenDefuse() {
  var containerDiv = document.createElement('div');
  containerDiv.id = 'exploding-kitten-defuse';
  containerDiv.classList.add('overlay-defuse');

  var svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgElement.setAttribute('width', '2000');
  svgElement.setAttribute('height', '210');
  svgElement.classList.add('svg-rectangle');
  svgElement.id = 'svg-rectangle';
  var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('width', '1500');
  rect.setAttribute('height', '500');
  rect.style.fill = 'rgb(0,0,0)';
  svgElement.appendChild(rect);

  var defuseFontDiv = document.createElement('div');
  defuseFontDiv.classList.add('defuseFont-container');
  var defuseFont = document.createElement('img');
  defuseFont.src = 'assets/images/defuseFittenFont.png';
  defuseFont.classList.add('defuse-kitten-font');
  defuseFontDiv.appendChild(defuseFont);

  var wickDiv = document.createElement('div');
  wickDiv.classList.add('wick-container');
  var wickImg = document.createElement('img');
  wickImg.src = 'assets/images/explosionKittenFitilj.png';
  wickImg.classList.add('wick');
  wickDiv.appendChild(wickImg);

  var defuseContainerDiv = document.createElement('div');
  defuseContainerDiv.classList.add('defuse-container');
  var defuseImg = document.createElement('img');
  defuseImg.src = 'assets/images/defuseContainer.png';
  defuseImg.classList.add('img-defuse-container');
  defuseContainerDiv.appendChild(defuseImg);

  var sparkImg = document.createElement('img');
  sparkImg.id = 'spark';
  sparkImg.src = 'assets/images/sparkGif.gif';
  sparkImg.classList.add('spark');
  wickDiv.appendChild(defuseContainerDiv);
  wickDiv.appendChild(sparkImg);

  var meDiv = document.createElement('div');
  meDiv.classList.add('me-container');
  var myCardsDiv = document.createElement('div');
  myCardsDiv.classList.add('my-cards-container');
  var effectDiv = document.createElement('div');
  effectDiv.classList.add('effect-card-container');
  effectDiv.id = 'defuseContainer';
  myCardsDiv.appendChild(effectDiv);
  meDiv.appendChild(myCardsDiv);

  containerDiv.appendChild(svgElement);
  containerDiv.appendChild(defuseFontDiv);
  containerDiv.appendChild(wickDiv);
  containerDiv.appendChild(meDiv);
  document.getElementById('overlay-container').appendChild(containerDiv);
}
