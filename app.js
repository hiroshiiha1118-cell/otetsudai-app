const LEGACY_STORAGE_KEY = "otetsudai-bank-v1";
const FAMILY_STORAGE_KEY = "otetsudai-family-id";
const MEMBER_STORAGE_PREFIX = "otetsudai-active-member-";
const LEGACY_PIN_KEY = "otetsudai-parent-pin";
const DATABASE_URL = "https://otetsudai-hiros-260606-default-rtdb.asia-southeast1.firebasedatabase.app";

function createFamilyId() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function resolveFamilyId() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromLink = hash.get("family");
  const stored = localStorage.getItem(FAMILY_STORAGE_KEY);
  const familyId = /^[A-Za-z0-9_-]{20,}$/.test(fromLink || "")
    ? fromLink
    : /^[A-Za-z0-9_-]{20,}$/.test(stored || "")
      ? stored
      : createFamilyId();
  localStorage.setItem(FAMILY_STORAGE_KEY, familyId);
  if (fromLink !== familyId) {
    const url = new URL(location.href);
    url.hash = `family=${familyId}`;
    history.replaceState(null, "", url);
  }
  return familyId;
}

const familyId = resolveFamilyId();
const familyUrl = `${DATABASE_URL}/families/${familyId}`;
const memberStorageKey = `${MEMBER_STORAGE_PREFIX}${familyId}`;
const state = { entries: [], members: [], pin: "1234" };
let activeMemberId = localStorage.getItem(memberStorageKey);
let parentAuthorized = sessionStorage.getItem(`otetsudai-parent-auth-${familyId}`) === "1";
let pendingParentMemberId = null;
let cloudReady = false;
let lastAddedId = null;
let toastTimer = null;
let pendingChore = null;
let selectedEntryIds = new Set();
let selectionMode = false;
let suppressHistoryClick = false;
let longPressTimer = null;
let longPressStart = null;
let selectedHistoryDate = new Date();
let calendarViewDate = new Date();
let syncing = false;
let breakdownMemberId = null;
let breakdownLongPressTimer = null;
let breakdownLongPressStart = null;
let adjustmentEntryId = null;
let adjustmentSign = null;
let adjustmentAmount = null;
let rewardMemberId = null;
let rewardAmount = null;
let rewardEntryId = null;
let managedEntryId = null;
let calendarMemberId = null;
let historyMemberId = null;
let pendingPayoutMemberId = null;
let pendingPayoutEntryIds = null;
let breakdownSelectionMode = false;
let selectedBreakdownEntryIds = new Set();
let suppressBreakdownClick = false;

const yen = value => new Intl.NumberFormat("ja-JP").format(value);
const activeMember = () => state.members.find(member => member.id === activeMemberId);
const membersById = () => Object.fromEntries(state.members.map(member => [member.id, member]));
const isParentMode = () => activeMember()?.role === "parent" && parentAuthorized;
const entryAdjustment = entry => Number(entry.adjustment?.amount) || 0;
const entryTotal = entry => Number(entry.price) + entryAdjustment(entry);
const entriesTotal = entries => Math.max(
  0,
  entries.reduce((sum, entry) => sum + entryTotal(entry), 0),
);
const signedYen = value => `${value > 0 ? "+" : ""}${yen(value)}円`;
const escapeHtml = value => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");
const rewardAmounts = [10, 20, 30, 50, 100, 200, 300, 500, 1000];

const adjustmentAmounts = {
  minus: [10, 20, 30, 50, 100, 150, 200],
  plus: [10, 20, 30, 50, 100],
};

const adjustmentReasons = {
  minus: [
    "すぐにやらなかった",
    "途中でやめた",
    "遊び始めた",
    "その日で終わらせなかった",
  ],
  plus: [
    "徹底的にやってくれた",
    "＋αでやってくれた",
    "早く終わらしてくれた",
  ],
};

function setSyncStatus(text) {
  document.querySelector("#sync-status").textContent = text;
}

async function cloudRequest(path = "", method = "GET", value) {
  const response = await fetch(`${familyUrl}${path ? `/${path}` : ""}.json`, {
    method,
    headers: value === undefined ? undefined : { "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Cloud request failed: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

const cloudSet = (path, value) => cloudRequest(path, "PUT", value);
const cloudUpdate = changes => cloudRequest("", "PATCH", changes);
const cloudRemove = path => cloudRequest(path, "DELETE");

function sameDay(first, second) {
  return first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate();
}

function dateKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatDate(iso, withTime = false) {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("ja-JP", {
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

function unpaidEntriesForMember(memberId) {
  if (!memberId) return [];
  const memberEntries = state.entries
    .filter(entry => entry.memberId === memberId)
    .sort((first, second) => new Date(first.date) - new Date(second.date));
  const paidEntryIds = new Set();
  for (const entry of memberEntries) {
    if (entry.type !== "payout") continue;
    if (Array.isArray(entry.paidEntryIds)) {
      entry.paidEntryIds.forEach(id => paidEntryIds.add(id));
      continue;
    }
    memberEntries
      .filter(candidate =>
        (candidate.type === "chore" || candidate.type === "bonus") &&
        new Date(candidate.date) <= new Date(entry.date)
      )
      .forEach(candidate => paidEntryIds.add(candidate.id));
  }
  return memberEntries.filter(entry =>
    (entry.type === "chore" || entry.type === "bonus") && !paidEntryIds.has(entry.id)
  );
}

function currentEntries() {
  if (activeMember()?.role === "parent") return [];
  return unpaidEntriesForMember(activeMemberId);
}

function currentBalance() {
  return entriesTotal(currentEntries());
}

function showToast(message, canUndo = true) {
  clearTimeout(toastTimer);
  document.querySelector("#toast-message").textContent = message;
  document.querySelector("#undo").style.display = canUndo ? "" : "none";
  document.querySelector("#toast").classList.add("show");
  toastTimer = setTimeout(() => document.querySelector("#toast").classList.remove("show"), 3600);
}

function renderMemberList() {
  const list = document.querySelector("#member-list");
  if (!state.members.length) {
    list.innerHTML = '<div class="empty">まだ名前が登録されていません</div>';
    return;
  }
  list.innerHTML = state.members.map(member => `
    <button class="member-option" type="button" data-member-id="${member.id}">
      <span class="member-avatar">👤</span>
      <span>${member.name}</span>
      <span class="role-tag ${member.role === "parent" ? "parent" : ""}">${member.role === "parent" ? "親" : "子ども"}</span>
      <span style="margin-left:auto;color:#e75638">この人で使う ›</span>
    </button>
  `).join("");
}

function showMemberSetup() {
  renderMemberList();
  const dialog = document.querySelector("#setup-dialog");
  if (!dialog.open) dialog.showModal();
}

function chooseMember(memberId) {
  const member = state.members.find(candidate => candidate.id === memberId);
  if (!member) return;
  if (member.role === "parent" && !parentAuthorized) {
    pendingParentMemberId = member.id;
    openParentAccess();
    return;
  }
  activeMemberId = memberId;
  localStorage.setItem(memberStorageKey, memberId);
  historyMemberId = member.role === "parent" ? null : member.id;
  calendarMemberId = member.role === "parent" ? null : member.id;
  document.querySelector("#setup-dialog").close();
  render();
}

async function migrateLegacyEntries(member) {
  const migratedKey = `otetsudai-migrated-${familyId}`;
  if (localStorage.getItem(migratedKey)) return;
  const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '{"entries":[]}');
  if (!Array.isArray(legacy.entries) || !legacy.entries.length || state.entries.length) {
    localStorage.setItem(migratedKey, "1");
    return;
  }
  const changes = {};
  for (const oldEntry of legacy.entries) {
    const id = oldEntry.id || crypto.randomUUID();
    changes[`entries/${id}`] = {
      ...oldEntry,
      id,
      memberId: member.id,
      memberName: member.name,
    };
  }
  const legacyPin = localStorage.getItem(LEGACY_PIN_KEY);
  if (/^\d{4}$/.test(legacyPin || "")) changes.pin = legacyPin;
  await cloudUpdate(changes);
  localStorage.setItem(migratedKey, "1");
}

async function addMember(name, selectAfter = false, role = "child") {
  const cleanName = name.trim();
  if (!cleanName) throw new Error("名前を入力してください");
  if (state.members.some(member => member.name === cleanName)) {
    throw new Error("同じ名前がすでに登録されています");
  }
  const member = {
    id: crypto.randomUUID(),
    name: cleanName,
    role,
    createdAt: new Date().toISOString(),
  };
  await cloudSet(`members/${member.id}`, member);
  if (selectAfter || !activeMemberId) {
    activeMemberId = member.id;
    localStorage.setItem(memberStorageKey, member.id);
  }
  await migrateLegacyEntries(member);
  await syncFromCloud();
  return member;
}

function renderHistory() {
  const history = document.querySelector("#history");
  const memberMap = membersById();
  const member = activeMember();
  const visibleMemberId = member?.role === "parent" ? historyMemberId : activeMemberId;
  history.classList.toggle("selection-mode", selectionMode);
  document.querySelector("#selection-toolbar").classList.toggle("active", selectionMode);
  document.querySelector("#selection-count").textContent = `${selectedEntryIds.size}件を選択中`;
  const selectedEntries = [...state.entries]
    .filter(entry => sameDay(new Date(entry.date), selectedHistoryDate))
    .filter(entry => !visibleMemberId || entry.memberId === visibleMemberId)
    .sort((first, second) => new Date(second.date) - new Date(first.date));
  const today = new Date();
  const memberLabel = member?.role === "parent" && visibleMemberId
    ? `${memberMap[visibleMemberId]?.name || "子ども"}さん・`
    : "";
  document.querySelector("#history-label").textContent = memberLabel + (sameDay(selectedHistoryDate, today)
    ? "今日の記録"
    : `${selectedHistoryDate.getMonth() + 1}月${selectedHistoryDate.getDate()}日の記録`);
  history.setAttribute("aria-label", document.querySelector("#history-label").textContent);
  if (!selectedEntries.length) {
    history.innerHTML = '<div class="empty">この日のお手伝い記録はありません</div>';
    return;
  }
  history.innerHTML = selectedEntries.map(entry => {
    const memberName = memberMap[entry.memberId]?.name || entry.memberName || "名前なし";
    if (entry.type === "payout") {
      const parentCanManage = isParentMode() && historyMemberId === entry.memberId;
      return `
        <div class="history-item payout ${parentCanManage ? "parent-manageable" : ""}" ${parentCanManage ? `data-parent-history-entry="${entry.id}"` : ""}>
          <span class="history-dot"></span>
          <span class="history-main">
            <span class="history-name"><span class="member-tag">${memberName}</span>おこづかいを受け取りました</span>
            <span class="history-date">${formatDate(entry.date, true)}${parentCanManage ? "・長押しで削除" : ""}</span>
          </span>
          <span class="history-value">-${yen(entry.amount)}円</span>
        </div>`;
    }
    if (entry.type === "bonus") {
      return `
        <div class="history-item">
          <span class="history-dot"></span>
          <span class="history-main">
            <span class="history-name"><span class="member-tag">${memberName}</span>🎁 特別ごほうび</span>
            <span class="history-date">${formatDate(entry.date, true)}</span>
            <span class="reward-note">${escapeHtml(entry.reason)}</span>
          </span>
          <span class="history-value">+${yen(entry.price)}円</span>
        </div>`;
    }
    const adjustment = entryAdjustment(entry);
    const adjustmentNote = adjustment
      ? `<span class="adjustment-note ${adjustment < 0 ? "minus" : "plus"}">親からの調整 ${signedYen(adjustment)}：${entry.adjustment.reason}</span>`
      : "";
    return `
      <div class="history-item ${selectedEntryIds.has(entry.id) ? "selected" : ""}" data-entry-id="${entry.id}">
        <span class="history-check">${selectedEntryIds.has(entry.id) ? "✓" : ""}</span>
        <span class="history-dot"></span>
        <span class="history-main">
          <span class="history-name"><span class="member-tag">${memberName}</span>${entry.name}</span>
          <span class="history-date">${formatDate(entry.date, true)}・${selectionMode ? "タップで選択" : "長押しで削除選択"}</span>
          ${adjustmentNote}
        </span>
        <span class="history-value">${signedYen(entryTotal(entry))}</span>
      </div>`;
  }).join("");
}

function renderCalendar() {
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  const calendarMember = state.members.find(member => member.id === calendarMemberId);
  document.querySelector("#calendar-dialog-title").textContent = calendarMember
    ? `${calendarMember.name}さんのカレンダー`
    : "記録を見る日を選ぶ";
  document.querySelector("#calendar-title").textContent = `${year}年 ${month + 1}月`;
  const firstDay = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstDay.getDay());
  const choreDates = new Set(
    state.entries
      .filter(entry => entry.type === "chore")
      .filter(entry => !calendarMemberId || entry.memberId === calendarMemberId)
      .map(entry => dateKey(new Date(entry.date))),
  );
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = [];
  for (let index = 0; index < 42; index++) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const isCurrentMonth = date.getMonth() === month;
    const isPastOrToday = date <= todayStart;
    const hasChore = choreDates.has(dateKey(date));
    const classes = [
      "calendar-day",
      !isCurrentMonth ? "other-month" : "",
      sameDay(date, today) ? "today" : "",
      sameDay(date, selectedHistoryDate) ? "selected" : "",
      isCurrentMonth && hasChore ? "has-chore" : "",
      isCurrentMonth && isPastOrToday && !hasChore ? "no-chore" : "",
    ].filter(Boolean).join(" ");
    const status = isCurrentMonth
      ? hasChore ? "お手伝いあり" : isPastOrToday ? "お手伝いなし" : ""
      : "";
    days.push(`<button class="${classes}" type="button" data-calendar-date="${date.getFullYear()}-${date.getMonth()}-${date.getDate()}" aria-label="${date.getMonth() + 1}月${date.getDate()}日 ${status}">${date.getDate()}</button>`);
  }
  document.querySelector("#calendar-grid").innerHTML = days.join("");
}

function renderBreakdown(onlyMemberId = null) {
  if (onlyMemberId !== breakdownMemberId) {
    breakdownSelectionMode = false;
    selectedBreakdownEntryIds.clear();
  }
  breakdownMemberId = onlyMemberId;
  const container = document.querySelector("#breakdown-list");
  const adjustable = Boolean(onlyMemberId && isParentMode());
  container.classList.toggle("selection-mode", breakdownSelectionMode);
  document.querySelector("#breakdown-note").textContent = adjustable
    ? "長押しで複数選択できます。タップで個別操作もできます。"
    : "まだ支払われていないお手伝いを、子どもごとに表示しています。";
  const children = state.members.filter(member =>
    member.role !== "parent" && (!onlyMemberId || member.id === onlyMemberId)
  );
  if (!children.length) {
    container.innerHTML = '<div class="empty">名前がまだ登録されていません</div>';
    return;
  }
  container.innerHTML = children.map(member => {
    const entries = unpaidEntriesForMember(member.id);
    selectedBreakdownEntryIds = new Set([...selectedBreakdownEntryIds].filter(id =>
      entries.some(entry => entry.id === id)
    ));
    const total = entriesTotal(entries);
    const rows = entries.length
      ? [...entries].reverse().map(entry => {
        if (entry.type === "bonus") {
          return `
            <div class="breakdown-row ${adjustable ? "adjustable" : ""} ${selectedBreakdownEntryIds.has(entry.id) ? "selected" : ""}" ${adjustable ? `data-manage-entry="${entry.id}" data-breakdown-entry="${entry.id}"` : ""}>
              <span class="breakdown-check">${selectedBreakdownEntryIds.has(entry.id) ? "✓" : ""}</span>
              <span class="breakdown-chore">
                🎁 特別ごほうび
                <span class="breakdown-date">${formatDate(entry.date, true)}</span>
                <span class="reward-note">${escapeHtml(entry.reason)}</span>
              </span>
              <span class="breakdown-price">+${yen(entry.price)}円</span>
            </div>
          `;
        }
        const adjustment = entryAdjustment(entry);
        const adjustmentNote = adjustment
          ? `<span class="adjustment-note ${adjustment < 0 ? "minus" : "plus"}">${signedYen(adjustment)}：${entry.adjustment.reason}</span>`
          : "";
        return `
          <div class="breakdown-row ${adjustable ? "adjustable" : ""} ${selectedBreakdownEntryIds.has(entry.id) ? "selected" : ""}" ${adjustable ? `data-manage-entry="${entry.id}" data-breakdown-entry="${entry.id}" data-adjust-entry="${entry.id}"` : ""}>
            <span class="breakdown-check">${selectedBreakdownEntryIds.has(entry.id) ? "✓" : ""}</span>
            <span class="breakdown-chore">
              ${entry.name}
              <span class="breakdown-date">${formatDate(entry.date, true)}</span>
              ${adjustmentNote}
            </span>
            <span class="breakdown-price ${adjustment ? "adjusted" : ""}">
              ${signedYen(entryTotal(entry))}
              ${adjustment ? `<span class="breakdown-base">基本 ${yen(entry.price)}円</span>` : ""}
            </span>
          </div>
        `;
      }).join("")
      : '<div class="breakdown-empty">現在たまっているお金はありません</div>';
    return `
      <section class="breakdown-member">
        <div class="breakdown-member-head">
          <span>👤 ${member.name}</span>
          <span class="breakdown-total">${yen(total)}円</span>
        </div>
        <div class="breakdown-rows">${rows}</div>
      </section>
    `;
  }).join("");
  updateBreakdownSelectionToolbar();
}

function renderParentDashboard() {
  const container = document.querySelector("#parent-summary");
  const children = state.members.filter(member => member.role !== "parent");
  if (!children.length) {
    container.innerHTML = '<div class="empty">子どもの名前がまだ登録されていません</div>';
    return;
  }
  container.innerHTML = children.map(member => {
    const entries = unpaidEntriesForMember(member.id);
    const total = entriesTotal(entries);
    return `
      <section class="parent-child-card">
        <div class="parent-child-head">
          <button class="parent-child-name" type="button" data-parent-calendar="${member.id}">👤 ${member.name}</button>
          <span class="parent-child-balance">${yen(total)}円</span>
        </div>
        <p class="parent-child-meta">未払いの記録 ${entries.length}件</p>
        <div class="parent-card-actions">
          <button class="manage-detail" type="button" data-parent-detail="${member.id}">内訳を見る</button>
          <button class="manage-payout" type="button" data-parent-payout="${member.id}" ${total ? "" : "disabled"}>支払い済みにする</button>
          <button class="manage-reward" type="button" data-parent-reward="${member.id}">🎁 特別ごほうび</button>
        </div>
      </section>
    `;
  }).join("");
}

function renderParentMemberList() {
  const container = document.querySelector("#parent-member-list");
  if (!state.members.length) {
    container.innerHTML = '<div class="empty">登録された名前はありません</div>';
    return;
  }
  container.innerHTML = state.members.map(member => `
    <div class="parent-member-row">
      <span>👤 ${member.name}</span>
      <span class="role-tag ${member.role === "parent" ? "parent" : ""}">${member.role === "parent" ? "親" : "子ども"}</span>
      <button class="delete-name" type="button" data-delete-member="${member.id}">名前を削除</button>
    </div>
  `).join("");
}

function render() {
  const member = activeMember();
  const parentMode = member?.role === "parent" && parentAuthorized;
  document.querySelector("#switch-user").textContent = member ? `👤 ${member.name}` : "👤 名前を選ぶ";
  document.querySelector("#open-parent").hidden = !parentMode;
  document.querySelector("#parent-dashboard").classList.toggle("active", parentMode);
  document.querySelector("#child-balance-card").style.display = parentMode ? "none" : "";
  document.querySelector("#chore-heading").style.display = parentMode ? "none" : "";
  document.querySelector("#chore-list").style.display = parentMode ? "none" : "";
  document.querySelector("#balance-label").textContent = member
    ? `${member.name}の いま たまっているお金`
    : "いま たまっているお金";
  document.querySelector("#balance").textContent = yen(currentBalance());
  document.querySelector("#count").textContent = currentEntries().length;
  document.querySelector("#parent-balance").textContent = yen(currentBalance());
  document.querySelector("#payout-member-name").textContent = member?.name || "選択中";
  renderHistory();
  renderMemberList();
  renderBreakdown(document.querySelector("#breakdown-dialog").open ? breakdownMemberId : null);
  renderParentDashboard();
  renderParentMemberList();
  if (
    cloudReady &&
    (!member || !state.members.length) &&
    !document.querySelector("#parent-dialog").open
  ) {
    showMemberSetup();
  }
}

async function addChore(name, price) {
  const member = activeMember();
  if (!member) {
    showMemberSetup();
    return;
  }
  const entry = {
    id: crypto.randomUUID(),
    type: "chore",
    name,
    price,
    memberId: member.id,
    memberName: member.name,
    date: new Date().toISOString(),
  };
  lastAddedId = entry.id;
  selectedHistoryDate = new Date();
  await cloudSet(`entries/${entry.id}`, entry);
  await syncFromCloud();
  showToast(`${member.name}：${name} ＋${price}円！`);
}

document.querySelector("#today").textContent = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
}).format(new Date());

const confirmDialog = document.querySelector("#confirm-dialog");
document.querySelectorAll("[data-chore]").forEach(button => {
  button.addEventListener("click", () => {
    const member = activeMember();
    if (!member) {
      showMemberSetup();
      return;
    }
    pendingChore = { name: button.dataset.chore, price: Number(button.dataset.price) };
    button.closest("dialog")?.close();
    document.querySelector("#confirm-chore").textContent =
      `${member.name}：${pendingChore.name}　＋${pendingChore.price}円`;
    confirmDialog.showModal();
  });
});

document.querySelector("#confirm-ok").addEventListener("click", async () => {
  if (!pendingChore) return;
  const chore = pendingChore;
  pendingChore = null;
  confirmDialog.close();
  try {
    await addChore(chore.name, chore.price);
  } catch {
    showToast("保存できませんでした。通信を確認してください", false);
  }
});

document.querySelector("#confirm-not-yet").addEventListener("click", () => {
  pendingChore = null;
  confirmDialog.close();
});

const historyElement = document.querySelector("#history");
function cancelSelection() {
  selectionMode = false;
  selectedEntryIds.clear();
  renderHistory();
}

const clearLongPress = () => {
  clearTimeout(longPressTimer);
  longPressTimer = null;
  longPressStart = null;
};

historyElement.addEventListener("pointerdown", event => {
  const parentItem = event.target.closest("[data-parent-history-entry]");
  const item = parentItem || event.target.closest("[data-entry-id]");
  if (!item) return;
  clearLongPress();
  longPressStart = { x: event.clientX, y: event.clientY };
  longPressTimer = setTimeout(() => {
    if (parentItem) {
      longPressTimer = null;
      openEntryAction(parentItem.dataset.parentHistoryEntry);
      return;
    }
    const entry = state.entries.find(candidate => candidate.id === item.dataset.entryId);
    if (!entry || entry.type !== "chore") return;
    longPressTimer = null;
    selectionMode = true;
    selectedEntryIds.add(entry.id);
    suppressHistoryClick = true;
    renderHistory();
    navigator.vibrate?.(35);
    setTimeout(() => { suppressHistoryClick = false; }, 400);
  }, 650);
});
historyElement.addEventListener("pointerup", clearLongPress);
historyElement.addEventListener("pointercancel", clearLongPress);
historyElement.addEventListener("pointermove", event => {
  if (!longPressStart) return;
  if (Math.hypot(event.clientX - longPressStart.x, event.clientY - longPressStart.y) > 12) {
    clearLongPress();
  }
});
historyElement.addEventListener("contextmenu", event => {
  if (event.target.closest("[data-entry-id], [data-parent-history-entry]")) event.preventDefault();
});
historyElement.addEventListener("click", event => {
  if (!selectionMode || suppressHistoryClick) return;
  const item = event.target.closest("[data-entry-id]");
  if (!item) return;
  if (selectedEntryIds.has(item.dataset.entryId)) selectedEntryIds.delete(item.dataset.entryId);
  else selectedEntryIds.add(item.dataset.entryId);
  renderHistory();
});

document.querySelector("#delete-selected").addEventListener("click", async () => {
  if (!selectedEntryIds.size) return;
  const deletedCount = selectedEntryIds.size;
  const changes = {};
  for (const id of selectedEntryIds) changes[`entries/${id}`] = null;
  await cloudUpdate(changes);
  await syncFromCloud();
  selectionMode = false;
  selectedEntryIds.clear();
  showToast(`${deletedCount}件の記録を削除しました`, false);
});
document.querySelector("#cancel-selection").addEventListener("click", cancelSelection);

const calendarDialog = document.querySelector("#calendar-dialog");
document.querySelector("#open-calendar").addEventListener("click", () => {
  calendarMemberId = activeMember()?.role === "parent" ? null : activeMemberId;
  calendarViewDate = new Date(selectedHistoryDate.getFullYear(), selectedHistoryDate.getMonth(), 1);
  renderCalendar();
  calendarDialog.showModal();
});
document.querySelector("#previous-month").addEventListener("click", () => {
  calendarViewDate.setMonth(calendarViewDate.getMonth() - 1);
  renderCalendar();
});
document.querySelector("#next-month").addEventListener("click", () => {
  calendarViewDate.setMonth(calendarViewDate.getMonth() + 1);
  renderCalendar();
});
document.querySelector("#calendar-grid").addEventListener("click", event => {
  const day = event.target.closest("[data-calendar-date]");
  if (!day) return;
  const [year, month, date] = day.dataset.calendarDate.split("-").map(Number);
  cancelSelection();
  selectedHistoryDate = new Date(year, month, date);
  historyMemberId = activeMember()?.role === "parent" ? calendarMemberId : activeMemberId;
  renderHistory();
  calendarDialog.close();
  document.querySelector("#history-wrap").classList.add("open");
  document.querySelector("#history-toggle").setAttribute("aria-expanded", "true");
  document.querySelector("#history-arrow").textContent = "▲";
});

document.querySelector("#history-toggle").addEventListener("click", () => {
  const wrap = document.querySelector("#history-wrap");
  const isOpen = wrap.classList.toggle("open");
  document.querySelector("#history-toggle").setAttribute("aria-expanded", String(isOpen));
  document.querySelector("#history-arrow").textContent = isOpen ? "▲" : "▼";
});

document.querySelector("#open-cleanup").addEventListener("click", () => {
  document.querySelector("#cleanup-dialog").showModal();
});
document.querySelector("#open-breakdown").addEventListener("click", () => {
  renderBreakdown();
  document.querySelector("#breakdown-dialog").showModal();
});

function showAdjustmentStep(step) {
  document.querySelector("#adjust-step-sign").hidden = step !== "sign";
  document.querySelector("#adjust-step-amount").hidden = step !== "amount";
  document.querySelector("#adjust-step-reason").hidden = step !== "reason";
}

function openAdjustment(entryId) {
  if (!isParentMode()) return;
  const entry = state.entries.find(candidate => candidate.id === entryId && candidate.type === "chore");
  if (!entry) return;
  adjustmentEntryId = entry.id;
  adjustmentSign = null;
  adjustmentAmount = null;
  document.querySelector("#adjustment-target").textContent =
    `${entry.memberName || "子ども"}・${entry.name}（基本 ${yen(entry.price)}円）`;
  showAdjustmentStep("sign");
  document.querySelector("#adjustment-dialog").showModal();
  navigator.vibrate?.(35);
}

function openEntryAction(entryId) {
  if (!isParentMode()) return;
  const entry = state.entries.find(candidate =>
    candidate.id === entryId &&
    (candidate.type === "chore" || candidate.type === "bonus" || candidate.type === "payout")
  );
  if (!entry) return;
  managedEntryId = entry.id;
  const isBonus = entry.type === "bonus";
  const isPayout = entry.type === "payout";
  const editButton = document.querySelector("#entry-action-edit");
  const deleteButton = document.querySelector("#entry-action-delete");
  document.querySelector("#entry-action-target").textContent =
    `${entry.memberName || "子ども"}・${isPayout ? "支払い済み記録" : isBonus ? "特別ごほうび" : entry.name}（${isPayout ? `-${yen(entry.amount)}円` : signedYen(entryTotal(entry))}）`;
  editButton.textContent =
    isBonus ? "ポイント変更" : "ポイント調整";
  editButton.hidden = isPayout;
  deleteButton.style.gridColumn = isPayout ? "1 / -1" : "";
  document.querySelector("#entry-action-dialog").showModal();
  navigator.vibrate?.(35);
}

function selectedBreakdownEntries() {
  return unpaidEntriesForMember(breakdownMemberId).filter(entry =>
    selectedBreakdownEntryIds.has(entry.id)
  );
}

function updateBreakdownSelectionToolbar() {
  const toolbar = document.querySelector("#breakdown-selection-toolbar");
  const selected = selectedBreakdownEntries();
  const total = entriesTotal(selected);
  toolbar.classList.toggle("active", breakdownSelectionMode);
  document.querySelector("#breakdown-selection-count").textContent =
    `${selected.length}件選択中`;
  document.querySelector("#breakdown-selection-total").textContent =
    `合計 ${yen(total)}円`;
  document.querySelector("#pay-selected-breakdown").disabled = !selected.length || !total;
}

function cancelBreakdownSelection() {
  breakdownSelectionMode = false;
  selectedBreakdownEntryIds.clear();
  suppressBreakdownClick = false;
  renderBreakdown(breakdownMemberId);
}

function clearBreakdownLongPress() {
  clearTimeout(breakdownLongPressTimer);
  breakdownLongPressTimer = null;
  breakdownLongPressStart = null;
}

const breakdownList = document.querySelector("#breakdown-list");
breakdownList.addEventListener("pointerdown", event => {
  if (!breakdownMemberId || !isParentMode()) return;
  clearBreakdownLongPress();
  breakdownLongPressStart = { x: event.clientX, y: event.clientY };
  breakdownLongPressTimer = setTimeout(() => {
    breakdownLongPressTimer = null;
    breakdownSelectionMode = true;
    selectedBreakdownEntryIds.clear();
    suppressBreakdownClick = true;
    renderBreakdown(breakdownMemberId);
    navigator.vibrate?.(35);
    setTimeout(() => { suppressBreakdownClick = false; }, 400);
  }, 650);
});
breakdownList.addEventListener("pointerup", clearBreakdownLongPress);
breakdownList.addEventListener("pointercancel", clearBreakdownLongPress);
breakdownList.addEventListener("pointermove", event => {
  if (!breakdownLongPressStart) return;
  if (Math.hypot(
    event.clientX - breakdownLongPressStart.x,
    event.clientY - breakdownLongPressStart.y,
  ) > 12) {
    clearBreakdownLongPress();
  }
});
breakdownList.addEventListener("contextmenu", event => {
  if (event.target.closest("[data-manage-entry]")) event.preventDefault();
});
breakdownList.addEventListener("click", event => {
  const row = event.target.closest("[data-breakdown-entry]");
  if (!row || !isParentMode() || suppressBreakdownClick) return;
  if (breakdownSelectionMode) {
    const entryId = row.dataset.breakdownEntry;
    if (selectedBreakdownEntryIds.has(entryId)) selectedBreakdownEntryIds.delete(entryId);
    else selectedBreakdownEntryIds.add(entryId);
    renderBreakdown(breakdownMemberId);
    return;
  }
  openEntryAction(row.dataset.breakdownEntry);
});

document.querySelector("#cancel-breakdown-selection").addEventListener("click", cancelBreakdownSelection);
document.querySelector("#pay-selected-breakdown").addEventListener("click", () => {
  const selected = selectedBreakdownEntries();
  const member = state.members.find(candidate => candidate.id === breakdownMemberId);
  const amount = entriesTotal(selected);
  if (!member || !selected.length || !amount) return;
  pendingPayoutMemberId = member.id;
  pendingPayoutEntryIds = selected.map(entry => entry.id);
  document.querySelector("#payout-confirm-target").textContent =
    `${member.name}さん・${yen(amount)}円（選択 ${selected.length}件）`;
  document.querySelector("#payout-confirm-dialog").showModal();
});

document.querySelector("#entry-action-edit").addEventListener("click", () => {
  const entry = state.entries.find(candidate => candidate.id === managedEntryId);
  if (!entry || !isParentMode()) return;
  document.querySelector("#entry-action-dialog").close();
  if (entry.type === "bonus") openRewardEdit(entry.id);
  else openAdjustment(entry.id);
});

document.querySelector("#entry-action-delete").addEventListener("click", () => {
  const entry = state.entries.find(candidate => candidate.id === managedEntryId);
  if (!entry || !isParentMode()) return;
  document.querySelector("#entry-action-dialog").close();
  document.querySelector("#delete-entry-target").textContent =
    entry.type === "payout"
      ? `支払い済み記録 -${yen(entry.amount)}円`
      : `${entry.type === "bonus" ? "🎁 特別ごほうび" : entry.name} ${signedYen(entryTotal(entry))}`;
  document.querySelector("#delete-entry-dialog").showModal();
});

document.querySelector("#confirm-entry-delete").addEventListener("click", async () => {
  const entry = state.entries.find(candidate => candidate.id === managedEntryId);
  if (!entry || !isParentMode()) return;
  const button = document.querySelector("#confirm-entry-delete");
  button.disabled = true;
  try {
    await cloudRemove(`entries/${entry.id}`);
    document.querySelector("#delete-entry-dialog").close();
    managedEntryId = null;
    await syncFromCloud();
    renderBreakdown(breakdownMemberId);
    showToast(
      `${entry.type === "payout" ? "支払い済み記録" : entry.type === "bonus" ? "特別ごほうび" : entry.name}を削除しました`,
      false,
    );
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#adjust-step-sign").addEventListener("click", event => {
  const button = event.target.closest("[data-adjust-sign]");
  if (!button) return;
  adjustmentSign = button.dataset.adjustSign;
  const direction = adjustmentSign === "minus" ? -1 : 1;
  document.querySelector("#adjustment-amounts").innerHTML =
    adjustmentAmounts[adjustmentSign].map(amount => `
      <button class="adjust-option ${adjustmentSign}" type="button" data-adjust-amount="${amount}">
        ${signedYen(direction * amount)}
      </button>
    `).join("");
  showAdjustmentStep("amount");
});

document.querySelector("#adjustment-amounts").addEventListener("click", event => {
  const button = event.target.closest("[data-adjust-amount]");
  if (!button || !adjustmentSign) return;
  adjustmentAmount = Number(button.dataset.adjustAmount);
  document.querySelector("#adjustment-reasons").innerHTML =
    adjustmentReasons[adjustmentSign].map(reason => `
      <button class="adjust-option ${adjustmentSign}" type="button" data-adjust-reason="${reason}">
        ${reason}
      </button>
    `).join("");
  showAdjustmentStep("reason");
});

document.querySelector("#adjustment-reasons").addEventListener("click", async event => {
  const button = event.target.closest("[data-adjust-reason]");
  if (!button || !adjustmentEntryId || !adjustmentSign || !adjustmentAmount) return;
  const entry = state.entries.find(candidate => candidate.id === adjustmentEntryId);
  if (!entry || !isParentMode()) return;
  const amount = adjustmentSign === "minus" ? -adjustmentAmount : adjustmentAmount;
  const reason = button.dataset.adjustReason;
  await cloudSet(`entries/${entry.id}/adjustment`, {
    amount,
    reason,
    updatedAt: new Date().toISOString(),
    updatedBy: activeMember()?.name || "親",
  });
  document.querySelector("#adjustment-dialog").close();
  await syncFromCloud();
  renderBreakdown(breakdownMemberId);
  showToast(`${entry.name}を${signedYen(amount)}調整しました`, false);
});

document.querySelectorAll("[data-close]").forEach(button => {
  button.addEventListener("click", () => document.querySelector(`#${button.dataset.close}`).close());
});

document.querySelector("#undo").addEventListener("click", async () => {
  if (!lastAddedId) return;
  await cloudRemove(`entries/${lastAddedId}`);
  await syncFromCloud();
  lastAddedId = null;
  document.querySelector("#toast").classList.remove("show");
});

document.querySelector("#switch-user").addEventListener("click", showMemberSetup);
document.querySelector("#member-list").addEventListener("click", event => {
  const option = event.target.closest("[data-member-id]");
  if (option) chooseMember(option.dataset.memberId);
});
document.querySelector("#setup-dialog").addEventListener("cancel", event => {
  if (!activeMember()) event.preventDefault();
});

const parentDialog = document.querySelector("#parent-dialog");
function openParentAccess() {
  document.querySelector("#pin-panel").style.display = "";
  document.querySelector("#parent-panel").classList.remove("active");
  document.querySelector("#pin").value = "";
  document.querySelector("#pin-error").textContent = "";
  document.querySelector("#setting-message").textContent = "";
  parentDialog.showModal();
  setTimeout(() => document.querySelector("#pin").focus(), 100);
}
document.querySelector("#open-parent").addEventListener("click", () => {
  pendingParentMemberId = null;
  openParentAccess();
});
document.querySelector("#setup-parent-access").addEventListener("click", () => {
  pendingParentMemberId = null;
  document.querySelector("#setup-dialog").close();
  openParentAccess();
});

function unlockParent() {
  if (document.querySelector("#pin").value !== state.pin) {
    document.querySelector("#pin-error").textContent = "暗証番号が違います";
    return;
  }
  if (pendingParentMemberId) {
    parentAuthorized = true;
    sessionStorage.setItem(`otetsudai-parent-auth-${familyId}`, "1");
    const memberId = pendingParentMemberId;
    pendingParentMemberId = null;
    activeMemberId = memberId;
    localStorage.setItem(memberStorageKey, memberId);
    historyMemberId = null;
    calendarMemberId = null;
    parentDialog.close();
    if (document.querySelector("#setup-dialog").open) document.querySelector("#setup-dialog").close();
    render();
    return;
  }
  document.querySelector("#pin-panel").style.display = "none";
  document.querySelector("#parent-panel").classList.add("active");
  document.querySelector("#selected-child-payout").style.display =
    activeMember()?.role === "parent" ? "none" : "";
  render();
}
document.querySelector("#unlock").addEventListener("click", unlockParent);
document.querySelector("#pin").addEventListener("keydown", event => {
  if (event.key === "Enter") unlockParent();
});

async function payMember(memberId) {
  const member = state.members.find(candidate => candidate.id === memberId && candidate.role !== "parent");
  const entries = unpaidEntriesForMember(memberId);
  const amount = entriesTotal(entries);
  if (!member) {
    return;
  }
  if (!amount) {
    document.querySelector("#setting-message").textContent = "現在の残高は0円です";
    return;
  }
  pendingPayoutMemberId = member.id;
  pendingPayoutEntryIds = entries.map(entry => entry.id);
  document.querySelector("#payout-confirm-target").textContent =
    `${member.name}さん・${yen(amount)}円`;
  document.querySelector("#payout-confirm-dialog").showModal();
}

async function completePayout() {
  const member = state.members.find(candidate =>
    candidate.id === pendingPayoutMemberId && candidate.role !== "parent"
  );
  const parentPanelOpen = document.querySelector("#parent-panel").classList.contains("active");
  if (!member || (!isParentMode() && !parentPanelOpen)) return;
  const unpaidEntries = unpaidEntriesForMember(member.id);
  const payableEntries = Array.isArray(pendingPayoutEntryIds)
    ? unpaidEntries.filter(entry => pendingPayoutEntryIds.includes(entry.id))
    : unpaidEntries;
  const amount = entriesTotal(payableEntries);
  if (!amount) {
    document.querySelector("#payout-confirm-dialog").close();
    return;
  }
  const entry = {
    id: crypto.randomUUID(),
    type: "payout",
    amount,
    paidEntryIds: payableEntries.map(candidate => candidate.id),
    memberId: member.id,
    memberName: member.name,
    date: new Date().toISOString(),
  };
  const button = document.querySelector("#confirm-payout");
  button.disabled = true;
  try {
    await cloudSet(`entries/${entry.id}`, entry);
    document.querySelector("#payout-confirm-dialog").close();
    pendingPayoutMemberId = null;
    pendingPayoutEntryIds = null;
    breakdownSelectionMode = false;
    selectedBreakdownEntryIds.clear();
    await syncFromCloud();
    if (document.querySelector("#breakdown-dialog").open) renderBreakdown(breakdownMemberId);
    if (parentDialog.open) parentDialog.close();
    showToast(`${member.name}さんが${yen(amount)}円を受け取りました！`, false);
  } finally {
    button.disabled = false;
  }
}

document.querySelector("#payout").addEventListener("click", async () => {
  const member = activeMember();
  if (!member || member.role === "parent") return;
  await payMember(member.id);
});
document.querySelector("#confirm-payout").addEventListener("click", completePayout);

function renderRewardAmounts() {
  document.querySelector("#reward-amounts").innerHTML = rewardAmounts.map(amount => `
    <button class="reward-amount ${rewardAmount === amount ? "selected" : ""}" type="button" data-reward-amount="${amount}">
      ${yen(amount)}円
    </button>
  `).join("");
}

function openReward(memberId) {
  if (!isParentMode()) return;
  const member = state.members.find(candidate => candidate.id === memberId && candidate.role !== "parent");
  if (!member) return;
  rewardMemberId = member.id;
  rewardEntryId = null;
  rewardAmount = null;
  document.querySelector("#reward-target").textContent = `${member.name}さんへの特別ごほうび`;
  document.querySelector("#reward-reason").value = "";
  document.querySelector("#reward-reason-wrap").hidden = false;
  document.querySelector("#reward-error").textContent = "";
  document.querySelector("#save-reward").textContent = "ごほうびを追加する";
  renderRewardAmounts();
  document.querySelector("#reward-dialog").showModal();
}

function openRewardEdit(entryId) {
  if (!isParentMode()) return;
  const entry = state.entries.find(candidate => candidate.id === entryId && candidate.type === "bonus");
  if (!entry) return;
  rewardMemberId = entry.memberId;
  rewardEntryId = entry.id;
  rewardAmount = Number(entry.price);
  document.querySelector("#reward-target").textContent =
    `${entry.memberName || "子ども"}さんの特別ごほうび（現在 ${yen(entry.price)}円）`;
  document.querySelector("#reward-reason").value = entry.reason || "";
  document.querySelector("#reward-reason-wrap").hidden = true;
  document.querySelector("#reward-error").textContent = "";
  document.querySelector("#save-reward").textContent = "金額を変更する";
  renderRewardAmounts();
  document.querySelector("#reward-dialog").showModal();
}

document.querySelector("#reward-amounts").addEventListener("click", event => {
  const button = event.target.closest("[data-reward-amount]");
  if (!button) return;
  rewardAmount = Number(button.dataset.rewardAmount);
  document.querySelectorAll("[data-reward-amount]").forEach(option => {
    option.classList.toggle("selected", option === button);
  });
  document.querySelector("#reward-error").textContent = "";
});

document.querySelector("#save-reward").addEventListener("click", async () => {
  const member = state.members.find(candidate =>
    candidate.id === rewardMemberId && candidate.role !== "parent"
  );
  const reason = document.querySelector("#reward-reason").value.trim();
  const error = document.querySelector("#reward-error");
  if (!member || !isParentMode()) return;
  if (!rewardAmount) {
    error.textContent = "金額を選んでください";
    return;
  }
  if (!rewardEntryId && !reason) {
    error.textContent = "ごほうびの理由を入力してください";
    return;
  }
  const editingEntry = rewardEntryId
    ? state.entries.find(candidate => candidate.id === rewardEntryId && candidate.type === "bonus")
    : null;
  if (rewardEntryId && !editingEntry) return;
  const entry = {
    id: editingEntry?.id || crypto.randomUUID(),
    type: "bonus",
    name: "特別ごほうび",
    price: rewardAmount,
    reason: editingEntry?.reason || reason,
    memberId: member.id,
    memberName: member.name,
    createdBy: editingEntry?.createdBy || activeMember()?.name || "親",
    date: editingEntry?.date || new Date().toISOString(),
    ...(editingEntry ? {
      updatedAt: new Date().toISOString(),
      updatedBy: activeMember()?.name || "親",
    } : {}),
  };
  const button = document.querySelector("#save-reward");
  button.disabled = true;
  try {
    await cloudSet(`entries/${entry.id}`, entry);
    document.querySelector("#reward-dialog").close();
    await syncFromCloud();
    renderBreakdown(breakdownMemberId);
    showToast(
      editingEntry
        ? `特別ごほうびを${yen(entry.price)}円に変更しました`
        : `${member.name}さんに${yen(entry.price)}円の特別ごほうびを追加しました`,
      false,
    );
  } catch {
    error.textContent = "保存できませんでした。通信を確認してください";
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#parent-summary").addEventListener("click", async event => {
  const calendar = event.target.closest("[data-parent-calendar]");
  if (calendar) {
    calendarMemberId = calendar.dataset.parentCalendar;
    historyMemberId = calendarMemberId;
    selectedHistoryDate = new Date();
    calendarViewDate = new Date(
      selectedHistoryDate.getFullYear(),
      selectedHistoryDate.getMonth(),
      1,
    );
    renderCalendar();
    calendarDialog.showModal();
    return;
  }
  const detail = event.target.closest("[data-parent-detail]");
  if (detail) {
    renderBreakdown(detail.dataset.parentDetail);
    document.querySelector("#breakdown-dialog").showModal();
    return;
  }
  const reward = event.target.closest("[data-parent-reward]");
  if (reward) {
    openReward(reward.dataset.parentReward);
    return;
  }
  const payout = event.target.closest("[data-parent-payout]");
  if (payout) await payMember(payout.dataset.parentPayout);
});

document.querySelector("#parent-add-member").addEventListener("click", async () => {
  const input = document.querySelector("#parent-member-name");
  const message = document.querySelector("#setting-message");
  try {
    await addMember(input.value);
    input.value = "";
    message.style.color = "#32845a";
    message.textContent = "名前を追加しました";
  } catch (reason) {
    message.style.color = "#c7452d";
    message.textContent = reason.message;
  }
});

document.querySelector("#parent-add-profile").addEventListener("click", async () => {
  const input = document.querySelector("#parent-profile-name");
  const message = document.querySelector("#setting-message");
  try {
    await addMember(input.value, false, "parent");
    input.value = "";
    message.style.color = "#32845a";
    message.textContent = "親プロフィールを追加しました";
  } catch (reason) {
    message.style.color = "#c7452d";
    message.textContent = reason.message;
  }
});

document.querySelector("#parent-member-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-delete-member]");
  if (!button) return;
  const member = state.members.find(candidate => candidate.id === button.dataset.deleteMember);
  if (!member) return;
  const hasRecords = state.entries.some(entry => entry.memberId === member.id);
  const message = document.querySelector("#setting-message");
  if (hasRecords) {
    message.style.color = "#c7452d";
    message.textContent = `${member.name}には履歴があるため削除できません。先にその人の履歴を削除してください`;
    return;
  }
  if (!confirm(`${member.name}の名前登録を削除しますか？`)) return;
  await cloudRemove(`members/${member.id}`);
  if (activeMemberId === member.id) {
    activeMemberId = null;
    localStorage.removeItem(memberStorageKey);
    parentAuthorized = false;
    sessionStorage.removeItem(`otetsudai-parent-auth-${familyId}`);
  }
  await syncFromCloud();
  message.style.color = "#32845a";
  message.textContent = "名前を削除しました";
});

document.querySelector("#share-family").addEventListener("click", async () => {
  const shareUrl = location.href;
  try {
    if (navigator.share) {
      await navigator.share({ title: "おてつだい貯金", text: "家族用のおてつだいアプリです", url: shareUrl });
    } else {
      await navigator.clipboard.writeText(shareUrl);
      showToast("家族用リンクをコピーしました", false);
    }
  } catch (reason) {
    if (reason.name !== "AbortError") showToast("共有できませんでした", false);
  }
});

document.querySelector("#change-pin").addEventListener("click", async () => {
  const value = document.querySelector("#new-pin").value;
  const message = document.querySelector("#setting-message");
  if (!/^\d{4}$/.test(value)) {
    message.style.color = "#c7452d";
    message.textContent = "数字4桁で入力してください";
    return;
  }
  await cloudSet("pin", value);
  await syncFromCloud();
  document.querySelector("#new-pin").value = "";
  message.style.color = "#32845a";
  message.textContent = "暗証番号を変更しました";
});

async function syncFromCloud() {
  if (syncing) return;
  syncing = true;
  try {
    const data = await cloudRequest() || {};
    state.entries = Object.values(data.entries || {}).sort(
      (first, second) => new Date(first.date) - new Date(second.date),
    );
    state.members = Object.values(data.members || {})
      .map(member => ({ ...member, role: member.role === "parent" ? "parent" : "child" }))
      .sort((first, second) => new Date(first.createdAt) - new Date(second.createdAt));
    state.pin = /^\d{4}$/.test(data.pin || "") ? data.pin : "1234";
    cloudReady = true;
    setSyncStatus("クラウド同期済み");
    if (activeMemberId && !state.members.some(member => member.id === activeMemberId)) {
      activeMemberId = null;
      localStorage.removeItem(memberStorageKey);
    }
    if (activeMember()?.role === "parent" && !parentAuthorized) {
      activeMemberId = null;
      localStorage.removeItem(memberStorageKey);
    }
    render();
  } catch {
    setSyncStatus("同期エラー");
  } finally {
    syncing = false;
  }
}

render();
await syncFromCloud();
setInterval(syncFromCloud, 2000);
window.addEventListener("focus", syncFromCloud);
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").then(registration => registration.update());
}
