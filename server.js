const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const MAX_SEATS = 6;
const STARTING_STACK = 100;
const SMALL_BLIND = 0.5;
const BIG_BLIND = 1;
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_LABELS = {
  11: "J",
  12: "Q",
  13: "K",
  14: "A"
};

const clients = new Map();
let nextHandTimer = null;

const game = {
  seats: Array(MAX_SEATS).fill(null),
  button: -1,
  deck: [],
  community: [],
  pot: 0,
  winningSeats: [],
  currentBet: 0,
  minRaise: BIG_BLIND,
  phase: "waiting",
  actionSeat: null,
  handActive: false,
  messages: ["NL100 6-Max table opened."]
};

function id() {
  return crypto.randomUUID();
}

function chips(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function formatChips(value) {
  return `${chips(value).toFixed(2).replace(/\.00$/, "")} BB`;
}

function cardLabel(card) {
  return `${RANK_LABELS[card.rank] || card.rank}${card.suit}`;
}

function log(message) {
  game.messages.push(message);
  game.messages = game.messages.slice(-80);
}

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

function activeSeatIndexes() {
  return game.seats
    .map((seat, index) => (seat && seat.stack > 0 ? index : null))
    .filter((index) => index !== null);
}

function nextOccupied(fromIndex, predicate = () => true) {
  for (let offset = 1; offset <= MAX_SEATS; offset += 1) {
    const index = (fromIndex + offset + MAX_SEATS) % MAX_SEATS;
    const seat = game.seats[index];
    if (seat && predicate(seat, index)) return index;
  }
  return null;
}

function handPlayers() {
  return game.seats
    .map((seat, index) => (seat?.inHand ? { seat, index } : null))
    .filter(Boolean);
}

function livePlayers() {
  return handPlayers().filter(({ seat }) => !seat.folded);
}

function actionCandidates() {
  return livePlayers().filter(({ seat }) => seat.stack > 0);
}

function pay(seat, amount) {
  const paid = chips(Math.min(seat.stack, Math.max(0, amount)));
  seat.stack = chips(seat.stack - paid);
  seat.bet = chips(seat.bet + paid);
  seat.handContribution = chips(seat.handContribution + paid);
  return paid;
}

function postBlind(index, amount, label) {
  const seat = game.seats[index];
  const paid = pay(seat, amount);
  log(`${seat.name} posts ${label} ${formatChips(paid)}.`);
}

function collectBets() {
  const total = game.seats.reduce((sum, seat) => sum + (seat?.bet || 0), 0);
  game.pot = chips(game.pot + total);
  for (const seat of game.seats) {
    if (seat) seat.bet = 0;
  }
}

function resetActionFlags(exceptIndex = null) {
  for (const { seat, index } of livePlayers()) {
    seat.acted = index === exceptIndex;
  }
}

function startHand() {
  const active = activeSeatIndexes();
  if (active.length < 2 || game.handActive) {
    game.phase = active.length < 2 ? "waiting" : game.phase;
    broadcast();
    return;
  }

  clearTimeout(nextHandTimer);
  nextHandTimer = null;
  game.deck = makeDeck();
  game.community = [];
  game.pot = 0;
  game.winningSeats = [];
  game.currentBet = BIG_BLIND;
  game.minRaise = BIG_BLIND;
  game.phase = "preflop";
  game.handActive = true;

  const previousButton = game.button >= 0 ? game.button : active[active.length - 1];
  game.button = nextOccupied(previousButton, (seat) => seat.stack > 0);

  for (const seat of game.seats) {
    if (!seat) continue;
    seat.cards = [];
    seat.folded = false;
    seat.acted = false;
    seat.bet = 0;
    seat.handContribution = 0;
    seat.inHand = seat.stack > 0;
  }

  const buttonSeat = game.seats[game.button];
  log(`Hand started. ${buttonSeat.name} has the button.`);

  const handCount = handPlayers().length;
  let smallBlindIndex;
  let bigBlindIndex;
  if (handCount === 2) {
    smallBlindIndex = game.button;
    bigBlindIndex = nextOccupied(game.button, (seat) => seat.inHand);
  } else {
    smallBlindIndex = nextOccupied(game.button, (seat) => seat.inHand);
    bigBlindIndex = nextOccupied(smallBlindIndex, (seat) => seat.inHand);
  }

  postBlind(smallBlindIndex, SMALL_BLIND, "small blind");
  postBlind(bigBlindIndex, BIG_BLIND, "big blind");

  for (let round = 0; round < 2; round += 1) {
    for (const { seat } of handPlayers()) {
      seat.cards.push(game.deck.pop());
    }
  }

  game.actionSeat = nextActionSeat(bigBlindIndex);
  broadcast();
}

function nextActionSeat(fromIndex) {
  for (let offset = 1; offset <= MAX_SEATS; offset += 1) {
    const index = (fromIndex + offset + MAX_SEATS) % MAX_SEATS;
    const seat = game.seats[index];
    if (!seat || !seat.inHand || seat.folded || seat.stack <= 0) continue;
    if (!seat.acted || seat.bet < game.currentBet) return index;
  }
  return null;
}

function bettingComplete() {
  const candidates = actionCandidates();
  if (candidates.length === 0) return true;
  return candidates.every(({ seat }) => seat.acted && seat.bet >= game.currentBet);
}

function finishByFold() {
  const winner = livePlayers()[0];
  collectBets();
  const wonPot = game.pot;
  winner.seat.stack = chips(winner.seat.stack + wonPot);
  game.winningSeats = [winner.index];
  log(`${winner.seat.name} wins ${formatChips(wonPot)}.`);
  game.pot = 0;
  endHand();
}

function advanceAfterAction(fromIndex) {
  if (livePlayers().length === 1) {
    finishByFold();
    return;
  }

  if (bettingComplete()) {
    collectBets();
    advanceStreet();
    return;
  }

  game.actionSeat = nextActionSeat(fromIndex);
  broadcast();
}

function advanceStreet() {
  game.currentBet = 0;
  game.minRaise = BIG_BLIND;
  for (const { seat } of livePlayers()) {
    seat.acted = false;
  }

  if (actionCandidates().length === 0) {
    runOutBoard();
    showdown();
    return;
  }

  if (game.phase === "preflop") {
    game.phase = "flop";
    game.community.push(game.deck.pop(), game.deck.pop(), game.deck.pop());
    log(`Flop: ${game.community.map(cardLabel).join(" ")}.`);
  } else if (game.phase === "flop") {
    game.phase = "turn";
    game.community.push(game.deck.pop());
    log(`Turn: ${cardLabel(game.community[3])}.`);
  } else if (game.phase === "turn") {
    game.phase = "river";
    game.community.push(game.deck.pop());
    log(`River: ${cardLabel(game.community[4])}.`);
  } else {
    showdown();
    return;
  }

  game.actionSeat = nextActionSeat(game.button);
  if (game.actionSeat === null || bettingComplete()) {
    advanceStreet();
    return;
  }
  broadcast();
}

function runOutBoard() {
  while (game.community.length < 5) {
    game.community.push(game.deck.pop());
  }
}

function endHand() {
  game.phase = "showdown";
  game.handActive = false;
  game.actionSeat = null;
  for (const seat of game.seats) {
    if (seat) {
      seat.inHand = false;
      seat.acted = false;
      seat.bet = 0;
    }
  }
  broadcast();
  scheduleNextHand();
}

function scheduleNextHand() {
  clearTimeout(nextHandTimer);
  nextHandTimer = setTimeout(() => {
    nextHandTimer = null;
    startHand();
  }, 4500);
}

function applyAction(playerId, type, amount) {
  const index = game.seats.findIndex((seat) => seat?.id === playerId);
  if (index < 0) throw new Error("Join a seat first.");
  if (index !== game.actionSeat) throw new Error("It is not your turn.");
  const seat = game.seats[index];
  const owed = chips(Math.max(0, game.currentBet - seat.bet));

  if (type === "fold") {
    seat.folded = true;
    seat.acted = true;
    log(`${seat.name} folds.`);
    advanceAfterAction(index);
    return;
  }

  if (type === "check") {
    if (owed > 0) throw new Error(`Call ${formatChips(owed)} or fold.`);
    seat.acted = true;
    log(`${seat.name} checks.`);
    advanceAfterAction(index);
    return;
  }

  if (type === "call") {
    if (owed <= 0) throw new Error("There is nothing to call.");
    const paid = pay(seat, owed);
    seat.acted = true;
    log(`${seat.name} calls ${formatChips(paid)}.`);
    advanceAfterAction(index);
    return;
  }

  if (type === "bet") {
    if (game.currentBet > 0) throw new Error("Raise or call instead.");
    const target = chips(amount);
    if (target < BIG_BLIND && seat.stack > target) throw new Error(`Minimum bet is ${formatChips(BIG_BLIND)}.`);
    if (target <= 0 || target > seat.stack) throw new Error("Bet amount is outside your stack.");
    pay(seat, target);
    game.currentBet = seat.bet;
    game.minRaise = seat.bet;
    resetActionFlags(index);
    log(`${seat.name} bets ${formatChips(seat.bet)}.`);
    advanceAfterAction(index);
    return;
  }

  if (type === "raise") {
    if (game.currentBet <= 0) throw new Error("Bet instead.");
    const target = chips(amount);
    const maxTarget = chips(seat.bet + seat.stack);
    const minTarget = chips(game.currentBet + game.minRaise);
    if (target <= game.currentBet) throw new Error("Raise amount must be above the current bet.");
    if (target > maxTarget) throw new Error("Raise amount is outside your stack.");
    if (target < minTarget && target < maxTarget) throw new Error(`Minimum raise is to ${formatChips(minTarget)}.`);
    const previousBet = game.currentBet;
    pay(seat, target - seat.bet);
    if (seat.bet - previousBet >= game.minRaise) {
      game.minRaise = chips(seat.bet - previousBet);
      game.currentBet = seat.bet;
      resetActionFlags(index);
    } else {
      game.currentBet = Math.max(game.currentBet, seat.bet);
      seat.acted = true;
    }
    log(`${seat.name} raises to ${formatChips(seat.bet)}.`);
    advanceAfterAction(index);
    return;
  }

  throw new Error("Unknown action.");
}

function showdown() {
  collectBets();
  runOutBoard();
  const contenders = livePlayers();
  const ranked = contenders.map(({ seat, index }) => ({
    seat,
    index,
    value: bestHand([...seat.cards, ...game.community])
  }));

  const levels = [...new Set(game.seats
    .filter(Boolean)
    .map((seat) => seat.handContribution)
    .filter((value) => value > 0))]
    .sort((a, b) => a - b);

  let previous = 0;
  const winningSeats = new Set();
  for (const level of levels) {
    const potPlayers = game.seats.filter((seat) => seat && seat.handContribution >= level);
    const potSize = chips((level - previous) * potPlayers.length);
    const eligible = ranked.filter(({ seat }) => seat.handContribution >= level);
    const best = eligible.reduce((winner, item) => compareHands(item.value, winner.value) > 0 ? item : winner, eligible[0]);
    const winners = eligible.filter((item) => compareHands(item.value, best.value) === 0);
    const share = chips(potSize / winners.length);
    for (const winner of winners) {
      winner.seat.stack = chips(winner.seat.stack + share);
      winningSeats.add(winner.index);
    }
    log(`${winners.map(({ seat }) => seat.name).join(" and ")} win ${formatChips(potSize)} with ${best.value.name}.`);
    previous = level;
  }

  game.winningSeats = [...winningSeats];
  game.pot = 0;
  endHand();
}

function bestHand(cards) {
  let best = null;
  const combos = combinations(cards, 5);
  for (const combo of combos) {
    const value = evaluateFive(combo);
    if (!best || compareHands(value, best) > 0) {
      best = value;
    }
  }
  return best;
}

function combinations(cards, size) {
  const result = [];
  function walk(start, picked) {
    if (picked.length === size) {
      result.push(picked.slice());
      return;
    }
    for (let index = start; index <= cards.length - (size - picked.length); index += 1) {
      picked.push(cards[index]);
      walk(index + 1, picked);
      picked.pop();
    }
  }
  walk(0, []);
  return result;
}

function evaluateFive(cards) {
  const ranks = cards.map((card) => card.rank).sort((a, b) => b - a);
  const counts = new Map();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) || 0) + 1);
  const groups = [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const straightHigh = getStraightHigh(ranks);

  if (flush && straightHigh) return handValue(8, [straightHigh], "straight flush");
  if (groups[0].count === 4) return handValue(7, [groups[0].rank, groups[1].rank], "four of a kind");
  if (groups[0].count === 3 && groups[1].count === 2) return handValue(6, [groups[0].rank, groups[1].rank], "full house");
  if (flush) return handValue(5, ranks, "flush");
  if (straightHigh) return handValue(4, [straightHigh], "straight");
  if (groups[0].count === 3) {
    const kickers = groups.filter((group) => group.count === 1).map((group) => group.rank).sort((a, b) => b - a);
    return handValue(3, [groups[0].rank, ...kickers], "three of a kind");
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairs = groups.filter((group) => group.count === 2).map((group) => group.rank).sort((a, b) => b - a);
    const kicker = groups.find((group) => group.count === 1).rank;
    return handValue(2, [...pairs, kicker], "two pair");
  }
  if (groups[0].count === 2) {
    const kickers = groups.filter((group) => group.count === 1).map((group) => group.rank).sort((a, b) => b - a);
    return handValue(1, [groups[0].rank, ...kickers], "one pair");
  }
  return handValue(0, ranks, "high card");
}

function getStraightHigh(ranks) {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let index = 0; index <= unique.length - 5; index += 1) {
    const window = unique.slice(index, index + 5);
    if (window[0] - window[4] === 4) return window[0] === 1 ? 5 : window[0];
  }
  return 0;
}

function handValue(category, ranks, name) {
  return { category, ranks, name };
}

function compareHands(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  for (let index = 0; index < Math.max(a.ranks.length, b.ranks.length); index += 1) {
    const diff = (a.ranks[index] || 0) - (b.ranks[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function sanitizeState(playerId) {
  const totalBets = game.seats.reduce((sum, seat) => sum + (seat?.bet || 0), 0);
  return {
    phase: game.phase,
    button: game.button,
    actionSeat: game.actionSeat,
    currentBet: game.currentBet,
    minRaise: game.minRaise,
    pot: chips(game.pot + totalBets),
    winningSeats: game.winningSeats,
    community: game.community.map(publicCard),
    messages: game.messages,
    seats: game.seats.map((seat, index) => {
      if (!seat) return null;
      const isHero = seat.id === playerId;
      const showCards = game.phase === "showdown" && seat.cards.length === 2 && !seat.folded;
      return {
        seatIndex: index,
        name: seat.name,
        stack: seat.stack,
        bet: seat.bet,
        folded: seat.folded,
        allIn: seat.inHand && seat.stack <= 0,
        inHand: seat.inHand,
        isHero,
        showCards,
        cards: seat.cards.map((card) => (isHero || showCards ? publicCard(card) : { hidden: true }))
      };
    })
  };
}

function publicCard(card) {
  return {
    rank: RANK_LABELS[card.rank] || String(card.rank),
    suit: card.suit
  };
}

function broadcast() {
  for (const [playerId, response] of clients.entries()) {
    response.write(`event: state\ndata: ${JSON.stringify(sanitizeState(playerId))}\n\n`);
  }
}

function sendJSON(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function serveStatic(request, response) {
  const requestedPath = request.url === "/" ? "/index.html" : new URL(request.url, "http://localhost").pathname;
  const filePath = path.join(ROOT, path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  const contentType = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript"
  }[path.extname(filePath)] || "text/plain";
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentType });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/events") {
      const playerId = url.searchParams.get("playerId");
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      response.write(`event: state\ndata: ${JSON.stringify(sanitizeState(playerId))}\n\n`);
      if (playerId) clients.set(playerId, response);
      request.on("close", () => {
        if (playerId && clients.get(playerId) === response) clients.delete(playerId);
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/state") {
      sendJSON(response, 200, sanitizeState(url.searchParams.get("playerId")));
      return;
    }

    if (request.method === "POST" && url.pathname === "/join") {
      const body = await readBody(request);
      const name = String(body.name || "Player").trim().slice(0, 18);
      let playerId = String(body.playerId || "");
      let seatIndex = game.seats.findIndex((seat) => seat?.id === playerId);
      if (seatIndex >= 0) {
        game.seats[seatIndex].name = name;
      } else {
        seatIndex = game.seats.findIndex((seat) => !seat);
        if (seatIndex < 0) throw new Error("The table is full.");
        playerId = id();
        game.seats[seatIndex] = {
          id: playerId,
          name,
          stack: STARTING_STACK,
          cards: [],
          folded: false,
          acted: false,
          bet: 0,
          handContribution: 0,
          inHand: false
        };
        log(`${name} joined seat ${seatIndex + 1} with ${formatChips(STARTING_STACK)}.`);
      }
      if (!game.handActive && activeSeatIndexes().length >= 2) scheduleNextHand();
      broadcast();
      sendJSON(response, 200, { playerId, seatIndex });
      return;
    }

    if (request.method === "POST" && url.pathname === "/action") {
      const body = await readBody(request);
      applyAction(String(body.playerId || ""), String(body.type || ""), body.amount);
      sendJSON(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET") {
      serveStatic(request, response);
      return;
    }

    response.writeHead(405);
    response.end("Method not allowed");
  } catch (error) {
    sendJSON(response, 400, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Buildmore Solution website running at http://${HOST}:${PORT}`);
});
