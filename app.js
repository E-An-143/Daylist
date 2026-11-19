(() => {
  'use strict';

  const STORE_KEY = 'daylist.v2';
  const CLOUD_TABLE = 'daylist_records';
  const CLOUD_PULL_MS = 8000;
  const cloudConfig = window.WORKBUDDY_CLOUD_CONFIG || null;
  let cloud = null;
  if (window.WorkBuddyCloud && cloudConfig && cloudConfig.endpoint && cloudConfig.publishableKey) {
    try {
      cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: cloudConfig.endpoint,
        publishableKey: cloudConfig.publishableKey
      });
    } catch (error) {
      console.warn('云同步初始化失败', error);
    }
  }
  const cloudReady = !!cloud;
  let lastAppliedUpdatedAt = 0;
  let pendingPush = false;
  let pushing = false;
  let pullPending = false;
  let pushTimer = null;
  const RANGE_MAX_DAYS = 31;
  const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const pad = value => String(value).padStart(2, '0');
  const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const parseKey = key => {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(year, month - 1, day);
  };
  const todayKey = () => dateKey(new Date());
  const addDays = (key, amount) => {
    const date = parseKey(key);
    date.setDate(date.getDate() + amount);
    return dateKey(date);
  };
  const daysBetween = (from, to) => Math.round((parseKey(to) - parseKey(from)) / 86400000);
  const validKey = key => typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key) && dateKey(parseKey(key)) === key;
  const startOfWeek = key => {
    const date = parseKey(key);
    const offset = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - offset);
    return dateKey(date);
  };
  const startOfMonth = date => new Date(date.getFullYear(), date.getMonth(), 1);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  const cleanId = value => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : uid());
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const toIso = value => {
    const date = value ? new Date(value) : new Date();
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  };

  const formatShort = key => {
    const date = parseKey(key);
    return `${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
  };
  const formatFull = key => {
    const date = parseKey(key);
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAY[date.getDay()]}`;
  };
  const formatTime = value => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const key = dateKey(date);
    const today = todayKey();
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (key === today) return `今天 ${time}`;
    if (key === addDays(today, -1)) return `昨天 ${time}`;
    if (date.getFullYear() === parseKey(today).getFullYear()) return `${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${time}`;
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  };
  const relativeLabel = key => {
    const offset = daysBetween(todayKey(), key);
    if (offset === 0) return '今天';
    if (offset === 1) return '明天';
    if (offset === -1) return '昨天';
    if (offset > 1) return `还有 ${offset} 天`;
    return `已过去 ${-offset} 天`;
  };
  const formatRangeCompact = (start, end) => {
    const from = parseKey(start);
    const to = parseKey(end);
    const head = `${pad(from.getMonth() + 1)}.${pad(from.getDate())}`;
    if (start === end) return head;
    const tail = from.getFullYear() === to.getFullYear()
      ? `${pad(to.getMonth() + 1)}.${pad(to.getDate())}`
      : `${to.getFullYear()}.${pad(to.getMonth() + 1)}.${pad(to.getDate())}`;
    return `${head} – ${tail}`;
  };

  /* ---------------- 动效辅助（iOS 风格过渡） ---------------- */

  const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const prefersReducedMotion = () => reduceMotionQuery.matches;

  let staggerNext = false;
  let scrimTimer = 0;

  // 卡片塌缩离场：先固定当前高度，加 is-exiting 后高度、内边距、边框归零并渐隐，
  // 动画结束后才执行重渲染，下方内容随布局自然上移补位。
  // mode='restore' 加 is-restore-exit：离场是「回到列表」的上浮而非销毁式的缩小
  function animateExit(card, after, mode) {
    if (!card || prefersReducedMotion()) {
      after();
      return;
    }
    // 列表的 gap 不随卡片高度归零而消失：塌缩全程用等量负 margin-bottom 同步抵消下方空隙，
    // 否则高度走完后仍剩一个 gap 的距离，要等重渲染移除节点时才瞬移补完——
    // 表现为补位在最后一小段距离处停顿一下再突然到位
    const parent = card.parentElement;
    const rowGap = parent ? parseFloat(getComputedStyle(parent).rowGap) || 0 : 0;
    card.style.height = `${card.offsetHeight}px`;
    // 高度已固定，起始帧移除真实边框不会改变占位；后续只动画 height/padding/margin，
    // 避免不足 1px 的边框被布局取整到 1px、终点才突然归零而产生 2px 跳变
    card.style.borderWidth = '0px';
    void card.offsetHeight;
    card.classList.add('is-exiting');
    if (mode === 'restore') card.classList.add('is-restore-exit');
    card.style.height = '0px';
    card.style.paddingTop = '0px';
    card.style.paddingBottom = '0px';
    if (rowGap > 0) card.style.marginBottom = `${-rowGap}px`;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      card.removeEventListener('transitionend', onEnd);
      after();
    };
    const onEnd = event => {
      if (event.target === card && event.propertyName === 'height') finish();
    };
    card.addEventListener('transitionend', onEnd);
    // 节点被切视图移除、浏览器不派发事件时仍有兜底，正常情况以 height 完成事件为准
    const timer = setTimeout(finish, transitionTimeout(card, 'height') + 80);
  }

  // 组头离场：分组在当天的最后一条待办被删除后，整个组块会在重渲染时被移除。
  // 分组名、计数、更多按钮与待办卡用同一组节奏收起：
  // 高度/外边距/内边距走 --duration-collapse + --ease-collapse，透明度 .2s ease；
  // 组块下外边距同步抵消列表 gap，收尾时空间已归零，重渲染时下方内容不再二次跳变。
  function animateGroupHead(block, after) {
    if (!block || prefersReducedMotion()) {
      after();
      return;
    }
    const head = block.querySelector(':scope > .group-head');
    if (!head) {
      after();
      return;
    }
    const stack = block.parentElement;
    const rowGap = stack ? parseFloat(getComputedStyle(stack).rowGap) || 0 : 0;
    // 与 animateExit 相同的起手式：先固定当前高度并强制一次同步布局，
    // auto 高度才有可插值的起点；随后高度与下边距归零、渐隐
    head.style.height = `${head.offsetHeight}px`;
    head.style.overflow = 'hidden';
    void head.offsetHeight;
    block.classList.add('is-head-exit');
    head.style.height = '0px';
    if (rowGap > 0) block.style.marginBottom = `${-rowGap}px`;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      head.removeEventListener('transitionend', onEnd);
      after();
    };
    const onEnd = event => {
      if (event.target === head && event.propertyName === 'height') finish();
    };
    head.addEventListener('transitionend', onEnd);
    const timer = setTimeout(finish, transitionTimeout(head, 'height') + 80);
  }

  // 面板（分组视图的组块、回收站分区）里最后一条内容离场时，标题行下方的留白若留到
  // 重渲染才收，条目收干净后还会再单独缩一截，看起来像卡了一下。
  // 这里让留白与条目塌缩同节奏归零，面板一路走到「只剩标题行」的高度，收尾没有第二段位移。
  function collapseHeadGap(panel) {
    const head = panel ? $('.group-head, .trash-head', panel) : null;
    if (!head || prefersReducedMotion()) return;
    const gap = parseFloat(getComputedStyle(head).marginBottom) || 0;
    if (gap <= 0) return;
    head.style.marginBottom = `${gap}px`;
    void head.offsetHeight;
    head.classList.add('is-gap-exit');
    head.style.marginBottom = '0px';
  }

  // 回收站里一批条目同时离场（恢复 / 彻底删除分组会连带它名下的待办）：
  // 所有条目共用同一节奏塌缩，全部播完再统一重渲染，避免其余条目在收尾时瞬间消失。
  // 某个分区被这批条目整批带走时，标题行的留白也随之一并收拢。
  function animateTrashItemsLeaving(items, mode) {
    const list = (items || []).filter(Boolean);
    if (!list.length) {
      renderAll();
      return;
    }
    const panels = Array.from(new Set(list.map(item => item.closest('.trash-panel')).filter(Boolean)));
    panels.forEach(panel => {
      const leaving = list.filter(item => panel.contains(item)).length;
      if (leaving >= $$('.trash-item', panel).length) collapseHeadGap(panel);
    });
    let remaining = list.length;
    const done = () => {
      remaining -= 1;
      if (remaining <= 0) renderAll();
    };
    list.forEach(item => animateExit(item, done, mode));
  }

  // 面板重渲染后变矮时（例如组内被删空、标题行改为居中），先按旧高度定位再过渡到新高度，
  // 补上面板边缘那一下，避免条目塌缩收干净后又突然缩一截。只处理变矮，长高直接铺开。
  function capturePanelHeights(host, selector, keyOf) {
    const heights = new Map();
    if (!host) return heights;
    $$(selector, host).forEach((panel, index) => {
      heights.set(keyOf(panel, index), panel.getBoundingClientRect().height);
    });
    return heights;
  }

  function animatePanelShrink(host, selector, keyOf, previous) {
    if (!host || !previous.size || prefersReducedMotion()) return;
    $$(selector, host).forEach((panel, index) => {
      const from = previous.get(keyOf(panel, index));
      if (from == null) return;
      const to = panel.getBoundingClientRect().height;
      if (from - to < 1) return;
      panel.style.overflow = 'hidden';
      panel.style.height = `${from}px`;
      void panel.offsetHeight;
      panel.classList.add('is-shrinking');
      panel.style.height = `${to}px`;

      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        panel.removeEventListener('transitionend', onEnd);
        panel.classList.remove('is-shrinking');
        panel.style.height = '';
        panel.style.overflow = '';
      };
      const onEnd = event => {
        if (event.target === panel && event.propertyName === 'height') finish();
      };
      panel.addEventListener('transitionend', onEnd);
      const timer = setTimeout(finish, transitionTimeout(panel, 'height') + 80);
    });
  }

  // 单日空态入场：这一天被删空后，空态提示若随重渲染直接落到版面上会显得凭空冒出。
  // 这里让它在卡片（以及组头）塌缩离场播完的那一刻接一段上浮淡入；
  // deleteTodo 先置位，renderDay 输出空态时消费一次。
  let dayEmptyEnterPending = false;

  function playDayEmptyEnter(element) {
    if (!dayEmptyEnterPending) return;
    dayEmptyEnterPending = false;
    if (!element || element.hidden || prefersReducedMotion()) return;
    element.classList.remove('is-empty-in');
    void element.offsetWidth;
    element.classList.add('is-empty-in');
    element.addEventListener('animationend', () => element.classList.remove('is-empty-in'), { once: true });
  }

  // 列表交错入场：仅视图/日期切换这一次渲染生效；--i 上限 12，一屏外的卡片延迟封顶、同时浮现
  function applyStagger() {
    const enabled = staggerNext;
    staggerNext = false;
    if (!enabled || prefersReducedMotion()) return;
    const containers = mode === 'day'
      ? [els.overdueBlock, els.taskList]
      : mode === 'groups' ? [els.groupsContent] : [];
    let index = 0;
    containers.forEach(container => {
      if (!container) return;
      $$('.task', container).forEach(card => {
        card.style.setProperty('--i', String(Math.min(index, 12)));
        index += 1;
      });
      container.classList.add('stagger');
    });
  }

  // 单日视图的方向滑动：向更晚日期从右滑入、更早从左滑入。
  // day-view 是持久元素，属性不变时 CSS 动画不会重播，需手动重启
  function applyDayDirection(dir) {
    if (prefersReducedMotion()) return;
    els.dayView.dataset.dayDir = dir;
    els.dayView.style.animation = 'none';
    void els.dayView.offsetHeight;
    els.dayView.style.animation = '';
  }

  // 跨平台开合：只插值明确的像素高度，不依赖 grid fr 或 auto 的可动画性。
  // 每次从当前可见高度接续，快速反复点击不会跳回起点；展开结束恢复 auto，
  // 让备注输入、字体加载和窗口改宽后的自然高度继续生效。
  const panelMotions = new WeakMap();

  function transitionTimeout(element, propertyName) {
    const style = getComputedStyle(element);
    const properties = style.transitionProperty.split(',').map(value => value.trim());
    const propertyIndex = properties.indexOf(propertyName);
    if (propertyIndex < 0) return 0;
    const durations = style.transitionDuration.split(',').map(value => value.trim());
    const delays = style.transitionDelay.split(',').map(value => value.trim());
    const toMs = value => (value.endsWith('ms') ? parseFloat(value) : parseFloat(value) * 1000) || 0;
    return toMs(durations[propertyIndex % durations.length]) + toMs(delays[propertyIndex % delays.length]);
  }

  function clearPanelMotion(panel) {
    const motion = panelMotions.get(panel);
    if (!motion) return;
    clearTimeout(motion.timer);
    panel.removeEventListener('transitionend', motion.onEnd);
    panelMotions.delete(panel);
  }

  function panelContentHeight(panel) {
    const content = panel.firstElementChild;
    if (!content) return 0;
    const style = getComputedStyle(content);
    const margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    return content.getBoundingClientRect().height + margins;
  }

  function setPanelOpen(panel, open, after) {
    if (!panel) return;
    clearPanelMotion(panel);
    const currentHeight = panel.getBoundingClientRect().height;
    const targetHeight = open ? panelContentHeight(panel) : 0;
    const finishNow = prefersReducedMotion() || Math.abs(currentHeight - targetHeight) < 0.5;

    if (finishNow) {
      panel.classList.toggle('is-open', open);
      panel.style.height = open ? 'auto' : '0px';
      panel.style.overflow = open ? 'visible' : 'hidden';
      if (after) after();
      return;
    }

    // 固定当前计算值并强制一次同步布局，保证新插入节点和 auto 高度都有可靠起点。
    panel.style.overflow = 'hidden';
    panel.style.height = `${currentHeight}px`;
    void panel.offsetHeight;
    panel.classList.toggle('is-open', open);

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      panel.removeEventListener('transitionend', onEnd);
      panelMotions.delete(panel);
      panel.style.height = open ? 'auto' : '0px';
      panel.style.overflow = open ? 'visible' : 'hidden';
      if (after) after();
    };
    const onEnd = event => {
      if (event.target === panel && event.propertyName === 'height') finish();
    };
    panel.addEventListener('transitionend', onEnd);
    const timer = setTimeout(finish, transitionTimeout(panel, 'height') + 80);
    panelMotions.set(panel, { onEnd, timer });
    panel.style.height = `${targetHeight}px`;
  }

  const els = {
    navOverview: $('#nav-overview'),
    navToday: $('#nav-today'),
    navGroups: $('#nav-groups'),
    navTrash: $('#nav-trash'),
    navOverdue: $('#nav-overdue'),
    navTodayCount: $('#nav-today-count'),
    navGroupCount: $('#nav-group-count'),
    navTrashCount: $('#nav-trash-count'),
    calPrev: $('#cal-prev'),
    calNext: $('#cal-next'),
    calTitle: $('#cal-title'),
    calGrid: $('#cal-grid'),
    monthRate: $('#month-rate'),
    monthBar: $('#month-bar'),
    monthCaption: $('#month-caption'),
    exportBtn: $('#export-btn'),
    importBtn: $('#import-btn'),
    importFile: $('#import-file'),
    menuBtn: $('#menu-btn'),
    navClose: $('#nav-close'),
    scrim: $('#scrim'),
    viewTitle: $('#view-title'),
    viewSub: $('#view-sub'),
    todayBtn: $('#today-btn'),
    groupViewAdd: $('#group-view-add'),
    fabNew: $('#fab-new'),
    weekStrip: $('#week-strip'),
    overviewView: $('#overview-view'),
    overviewContent: $('#overview-content'),
    dayView: $('#day-view'),
    groupsView: $('#groups-view'),
    groupsContent: $('#groups-content'),
    trashView: $('#trash-view'),
    trashContent: $('#trash-content'),
    dayDone: $('#day-done'),
    dayTotal: $('#day-total'),
    dayNote: $('#day-note'),
    dayBar: $('#day-bar'),
    quickAddBtn: $('#quick-add-btn'),
    quickInput: $('#quick-input'),
    groupAdd: $('#group-add'),
    overdueBlock: $('#overdue-block'),
    taskList: $('#task-list'),
    dayEmpty: $('#day-empty'),
    dialog: $('#todo-dialog'),
    form: $('#todo-form'),
    modalTitle: $('#modal-title'),
    titleInput: $('#todo-title'),
    groupField: $('#todo-group-field'),
    groupSelect: $('#todo-group'),
    todoError: $('#todo-error'),
    modalClose: $('#modal-close'),
    modalCancel: $('#modal-cancel'),
    groupDialog: $('#group-dialog'),
    groupForm: $('#group-form'),
    groupTitle: $('#group-title'),
    groupNameInput: $('#group-name'),
    groupError: $('#group-error'),
    groupClose: $('#group-close'),
    groupCancel: $('#group-cancel'),
    noticeDialog: $('#notice-dialog'),
    noticeTitle: $('#notice-title'),
    noticeText: $('#notice-text'),
    noticeClose: $('#notice-close'),
    noticeOk: $('#notice-ok'),
    moveDialog: $('#move-dialog'),
    moveTitle: $('#move-title'),
    moveList: $('#move-list'),
    moveClose: $('#move-close'),
    moveCancel: $('#move-cancel'),
    moveNew: $('#move-new'),
    dayDialog: $('#day-dialog'),
    dayCal: $('#day-cal'),
    dayCalNote: $('#day-cal-note'),
    dayClose: $('#day-close'),
    dayCancel: $('#day-cancel'),
    cloneDialog: $('#clone-dialog'),
    clonePicker: $('#clone-picker')
  };

  let todos = [];
  let groups = [];
  // 回收站：被删除的待办与分组暂存在这里，可恢复或彻底删除
  let trashTodos = [];
  let trashGroups = [];
  let mode = 'day';
  let selectedDate = todayKey();
  let calendarCursor = startOfMonth(new Date());
  let expanded = new Set();
  // 「今天」页的超期区块：列表默认收起，true 表示已展开
  let overdueOpen = false;
  let menuOpen = null;
  // 分组三点按钮的下拉菜单：记录当前展开菜单的分组 id（与待办条菜单互斥，同屏只开一个）
  let groupMenuOpen = null;
  let editingId = null;
  // 弹窗不再提供日期输入，当前弹窗对应的日期由内部变量传递：
  // 新建 = 打开时的上下文日期，编辑 = 待办原日期（保存时不修改）
  let dialogDate = todayKey();
  let noteFocusId = null;
  let lastKnownDay = todayKey();
  let groupDialogMode = 'create';
  let groupEditingId = null;
  let groupPendingMoveId = null;
  let groupPendingCreate = null;
  // 「移动到哪一天」弹窗：正在移动的待办 + 当前展示的月份
  let moveDayTodoId = null;
  let moveDayCursor = null;
  let moveTodoId = null;
  let pickContext = null;
  // 克隆日期独立于统计周期：普通模式选范围，高级模式从原日期的次日起按规则筛选。
  let cloneContext = null;
  // 周期总览默认看「前 6 天 + 今天起 8 天」，用户可以自行改开始与结束日期
  let rangeStart = addDays(todayKey(), -6);
  let rangeEnd = addDays(rangeStart, 13);
  let rangeOpen = false;
  // 自绘日历：正在编辑哪个端点（start / end），以及当前展示的月份
  let calField = null;
  let calCursor = null;

  function sanitizeTodo(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = String(raw.title == null ? '' : raw.title).trim().slice(0, 200);
    if (!title) return null;
    const seenNotes = new Set();
    const notes = (Array.isArray(raw.notes) ? raw.notes : []).map(note => {
      if (!note || typeof note !== 'object') return null;
      const text = String(note.text == null ? '' : note.text).trim().slice(0, 2000);
      if (!text) return null;
      const id = cleanId(note.id);
      const uniqueId = seenNotes.has(id) ? uid() : id;
      seenNotes.add(uniqueId);
      return {
        id: uniqueId,
        text,
        createdAt: toIso(note.createdAt)
      };
    }).filter(Boolean);
    return {
      id: cleanId(raw.id),
      date: validKey(raw.date) ? raw.date : todayKey(),
      title,
      done: Boolean(raw.done),
      highlighted: Boolean(raw.highlighted),
      groupId: typeof raw.groupId === 'string' && raw.groupId ? raw.groupId : null,
      createdAt: toIso(raw.createdAt),
      updatedAt: toIso(raw.updatedAt),
      completedAt: raw.completedAt ? toIso(raw.completedAt) : null,
      // 回收站时间戳：在回收站里的条目才有值，恢复时清空
      deletedAt: raw.deletedAt ? toIso(raw.deletedAt) : null,
      notes
    };
  }

  function sanitizeGroup(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name == null ? '' : raw.name).trim().slice(0, 24);
    if (!name) return null;
    // 删除分组时记录的组内待办 id：彻底删除分组时据此把同批进回收站的待办一并清除；
    // 恢复分组只还原空骨架，不再使用这份名单
    const memberIds = Array.isArray(raw.memberIds)
      ? raw.memberIds.filter(value => typeof value === 'string' && value && value.length <= 80)
      : [];
    return {
      id: cleanId(raw.id),
      name,
      createdAt: toIso(raw.createdAt),
      deletedAt: raw.deletedAt ? toIso(raw.deletedAt) : null,
      memberIds
    };
  }

  function dedupeGroups(list) {
    const seen = new Set();
    return list.map(sanitizeGroup).filter(Boolean).filter(group => {
      if (seen.has(group.id)) group.id = uid();
      seen.add(group.id);
      return true;
    });
  }

  function dedupeTodos(list) {
    const seen = new Set();
    return list.map(sanitizeTodo).filter(Boolean).filter(todo => {
      if (seen.has(todo.id)) todo.id = uid();
      seen.add(todo.id);
      return true;
    });
  }

  function normalizeGroups() {
    // 只保留仍然存在的分组引用，避免待办挂到已被删除的分组上
    const ids = new Set(groups.map(group => group.id));
    todos.forEach(todo => {
      if (todo.groupId && !ids.has(todo.groupId)) todo.groupId = null;
    });
  }

  function applyData(data) {
    groups = dedupeGroups(Array.isArray(data && data.groups) ? data.groups : []);
    todos = dedupeTodos(Array.isArray(data && data.todos) ? data.todos : []);
    const rawTrash = data && data.trash && typeof data.trash === 'object' ? data.trash : {};
    trashTodos = dedupeTodos(Array.isArray(rawTrash.todos) ? rawTrash.todos : []);
    trashGroups = dedupeGroups(Array.isArray(rawTrash.groups) ? rawTrash.groups : []);
    normalizeGroups();
  }

  function currentPayload() {
    return { version: 3, todos, groups, trash: { todos: trashTodos, groups: trashGroups } };
  }

  function saveLocalOnly() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(currentPayload()));
      return true;
    } catch (error) {
      console.warn('保存失败：浏览器存储空间可能已满', error);
      return false;
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) {
        todos = [];
        groups = [];
        trashTodos = [];
        trashGroups = [];
        return;
      }
      applyData(JSON.parse(raw));
    } catch (error) {
      todos = [];
      groups = [];
      trashTodos = [];
      trashGroups = [];
      console.warn('本地数据读取失败，已使用空清单', error);
    }
  }

  function save() {
    const ok = saveLocalOnly();
    if (ok) scheduleCloudPush();
    return ok;
  }

  async function pullCloud(initial) {
    if (!cloudReady) return false;
    if (pushing) { pullPending = true; return true; }
    try {
      const { data, error } = await cloud.database
        .from(CLOUD_TABLE)
        .select('data, updated_at')
        .maybeSingle();
      if (error) throw error;
      if (!data || !data.data || typeof data.data !== 'object') return true;
      const stamp = data.updated_at ? new Date(data.updated_at).getTime() : 0;
      if (!initial && stamp <= lastAppliedUpdatedAt) return true;
      // 本机有尚未上传的修改时，不让旧云端快照覆盖本地编辑
      if (pendingPush && !initial) return true;
      applyData(data.data);
      lastAppliedUpdatedAt = stamp;
      expanded.clear();
      overdueOpen = false;
      menuOpen = null;
      saveLocalOnly();
      renderAll();
      if (els.cloneDialog.open) renderClonePicker();
      return true;
    } catch (error) {
      console.warn('云端读取失败', error && error.message);
      return false;
    }
  }

  function scheduleCloudPush() {
    if (!cloudReady) return;
    pendingPush = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushCloud, 350);
  }

  async function pushCloud() {
    if (!cloudReady) return;
    if (pushing) { pullPending = true; return; }
    pushing = true;
    try {
      const { data, error } = await cloud.database
        .from(CLOUD_TABLE)
        .upsert({ data: currentPayload() }, { onConflict: 'owner_id' })
        .select('updated_at');
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      if (row && row.updated_at) lastAppliedUpdatedAt = new Date(row.updated_at).getTime();
      pendingPush = false;
      if (pullPending) {
        pullPending = false;
        setTimeout(() => pullCloud(), 0);
      }
    } catch (error) {
      console.warn('云端保存失败，记录已暂存在本机', error && error.message);
    } finally {
      pushing = false;
    }
  }

  async function initSync() {
    if (!cloudReady) return;
    const ok = await pullCloud(true);
    if (!ok) return;
    if (pendingPush) await pushCloud();
  }

  const findTodo = id => todos.find(todo => todo.id === id);
  const tasksForDate = key => todos.filter(todo => todo.date === key);
  const isOverdue = todo => !todo.done && todo.date < todayKey();
  const overdueDays = todo => Math.max(1, daysBetween(todo.date, todayKey()));
  // 状态分层：视觉状态归超期（红底徽章），排序权重归重点——重点标记的超期项永远排在最前
  const overdueTodos = () => todos.filter(isOverdue).sort((a, b) => {
    if (a.highlighted !== b.highlighted) return a.highlighted ? -1 : 1;
    return a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date.localeCompare(b.date);
  });

  function sortTasks(list) {
    return list.slice().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.done) return String(b.completedAt || b.updatedAt).localeCompare(String(a.completedAt || a.updatedAt));
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  function createTodo(title, date, groupId) {
    const now = new Date().toISOString();
    const todo = {
      id: uid(),
      date: validKey(date) ? date : todayKey(),
      title,
      done: false,
      highlighted: false,
      groupId: groupId && groups.some(group => group.id === groupId) ? groupId : null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      notes: []
    };
    todos.push(todo);
    save();
    return todo;
  }

  function countStats(today) {
    const todayTasks = tasksForDate(today);
    const todayDone = todayTasks.filter(todo => todo.done).length;
    const overdue = overdueTodos();
    const weekStart = startOfWeek(today);
    const weekEnd = addDays(weekStart, 6);
    const lastWeekStart = addDays(weekStart, -7);
    const lastWeekEnd = addDays(weekStart, -1);
    const weekTasks = todos.filter(todo => todo.date >= weekStart && todo.date <= weekEnd);
    const weekDone = weekTasks.filter(todo => todo.done).length;
    const completedThisWeek = todos.filter(todo => {
      if (!todo.completedAt) return false;
      const key = dateKey(new Date(todo.completedAt));
      return key >= weekStart && key <= weekEnd;
    }).length;
    const completedLastWeek = todos.filter(todo => {
      if (!todo.completedAt) return false;
      const key = dateKey(new Date(todo.completedAt));
      return key >= lastWeekStart && key <= lastWeekEnd;
    }).length;
    const highlightedTodos = todos.filter(todo => todo.highlighted);
    return {
      todayTasks, todayDone, overdue, weekStart, weekDone, weekTasks,
      weekRate: weekTasks.length ? Math.round(weekDone / weekTasks.length * 100) : 0,
      completedThisWeek, completedLastWeek,
      highlightedTodos
    };
  }

  function renderAll() {
    const today = todayKey();
    els.overdueBlock.classList.remove('stagger');
    els.taskList.classList.remove('stagger');
    els.groupsContent.classList.remove('stagger');
    renderSidebar(today);
    renderHeader(today);
    renderWeekStrip(today);
    // 单日与分组视图使用同一内容宽度，保证标题栏和正文左边缘对齐
    document.body.classList.toggle('is-day', mode === 'day');
    document.body.classList.toggle('is-groups', mode === 'groups');
    document.body.classList.toggle('is-trash', mode === 'trash');
    els.overviewView.hidden = mode !== 'overview';
    els.dayView.hidden = mode !== 'day';
    els.groupsView.hidden = mode !== 'groups';
    els.trashView.hidden = mode !== 'trash';
    if (mode === 'overview') {
      els.taskList.innerHTML = '';
      els.overdueBlock.innerHTML = '';
      els.groupsContent.innerHTML = '';
      renderOverview(today);
      document.title = '待办 · 总览';
    } else if (mode === 'groups') {
      els.taskList.innerHTML = '';
      els.overdueBlock.innerHTML = '';
      renderGroups(today);
      document.title = '待办 · 分组';
    } else if (mode === 'trash') {
      els.taskList.innerHTML = '';
      els.overdueBlock.innerHTML = '';
      els.groupsContent.innerHTML = '';
      renderTrash();
      document.title = '待办 · 回收站';
    } else {
      els.groupsContent.innerHTML = '';
      renderDay(today);
      document.title = `待办 · ${formatShort(selectedDate)}`;
    }
    if (noteFocusId) {
      const textarea = $(`.task[data-id="${noteFocusId}"] .note-add textarea`);
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        autoGrow(textarea);
      }
      noteFocusId = null;
    }
    applyStagger();
    document.body.classList.toggle('menu-open', Boolean(document.querySelector('.task-menu.is-open, .group-menu.is-open')));
  }

  function renderSidebar(today) {
    const stats = countStats(today);
    els.navOverview.classList.toggle('is-active', mode === 'overview');
    els.navToday.classList.toggle('is-active', mode === 'day' && selectedDate === today);
    els.navGroups.classList.toggle('is-active', mode === 'groups');
    els.navTrash.classList.toggle('is-active', mode === 'trash');
    els.navGroupCount.textContent = groups.length;
    els.navGroupCount.title = `${groups.length} 个分组`;
    els.navOverdue.textContent = stats.overdue.length;
    els.navOverdue.title = `${stats.overdue.length} 项超期`;
    els.navOverdue.classList.toggle('has-value', stats.overdue.length > 0);
    els.navTodayCount.textContent = `${stats.todayDone} / ${stats.todayTasks.length}`;
    els.navTodayCount.title = `今天已完成 ${stats.todayDone} / ${stats.todayTasks.length}`;
    const trashTotal = trashTodos.length + trashGroups.length;
    els.navTrashCount.textContent = trashTotal;
    els.navTrashCount.title = `回收站共 ${trashTotal} 项`;
    renderCalendar(today);
    renderMonthSummary();
  }

  function renderCalendar(today) {
    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    els.calTitle.textContent = `${year}年${month + 1}月`;
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let html = '';
    for (let i = 0; i < offset; i += 1) html += '<span class="cal-blank"></span>';
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${year}-${pad(month + 1)}-${pad(day)}`;
      const list = tasksForDate(key);
      const done = list.filter(todo => todo.done).length;
      const overdue = list.filter(isOverdue).length;
      const open = list.filter(todo => !todo.done).length;
      const dotClass = overdue ? 'overdue' : (list.length && done === list.length ? 'done' : (open ? 'open' : ''));
      const classes = ['cal-day'];
      if (key === today) classes.push('is-today');
      if (key === selectedDate && mode === 'day') classes.push('is-selected');
      const label = `${pad(month + 1)}.${pad(day)}，${list.length ? `${list.length} 项待办，${done} 项完成` : '没有待办'}${overdue ? `，${overdue} 项超期` : ''}`;
      html += `<button class="${classes.join(' ')}" type="button" data-date="${key}" aria-label="${escape(label)}" title="${escape(label)}"><span>${day}</span><span class="cal-dots">${dotClass ? `<i class="cal-dot ${dotClass}"></i>` : ''}</span></button>`;
    }
    // 侧边栏月历同样补满 6 周（42 格）：行数固定后侧栏整体高度不随翻月变化，
    // 下方的「当月进度」等模块不会跟着上下跳动
    for (let i = offset + daysInMonth; i < 42; i += 1) html += '<span class="cal-blank"></span>';
    els.calGrid.innerHTML = html;
  }

  function renderMonthSummary() {
    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    const prefix = `${year}-${pad(month + 1)}`;
    const list = todos.filter(todo => todo.date.startsWith(prefix));
    const done = list.filter(todo => todo.done).length;
    const rate = list.length ? Math.round(done / list.length * 100) : 0;
    els.monthRate.textContent = `${rate}%`;
    els.monthBar.style.transform = `scaleX(${rate / 100})`;
    els.monthCaption.textContent = list.length ? `已完成 ${done} / ${list.length} 项` : '共 0 项';
  }

  function renderHeader(today) {
    const stats = countStats(today);
    els.todayBtn.hidden = !(mode === 'day' && selectedDate !== today);
    els.weekStrip.hidden = mode !== 'day';
    els.groupViewAdd.hidden = mode !== 'groups';
    els.viewSub.hidden = mode === 'overview';

    if (mode === 'overview') {
      els.viewTitle.textContent = '总览';
      // 总览标题下方不显示任何文字与完成情况，直接进入下方内容
      els.viewSub.hidden = true;
      return;
    }

    if (mode === 'groups') {
      els.viewTitle.textContent = '分组';
      els.viewSub.textContent = `${groups.length} 个分组`;
      return;
    }

    if (mode === 'trash') {
      els.viewTitle.textContent = '回收站';
      els.viewSub.textContent = `${trashTodos.length} 项待办 · ${trashGroups.length} 个分组`;
      return;
    }

    els.viewTitle.textContent = formatFull(selectedDate);
    const list = tasksForDate(selectedDate);
    const done = list.filter(todo => todo.done).length;
    const overdueOnDay = list.filter(isOverdue).length;
    let sub = `${relativeLabel(selectedDate)} · ${done} / ${list.length} 已完成`;
    let danger = '';
    if (selectedDate === today && stats.overdue.length) {
      danger = ` · <span class="danger-text">${stats.overdue.length} 项超期</span>`;
    } else if (selectedDate < today && overdueOnDay) {
      danger = ` · <span class="danger-text">${overdueOnDay} 项未完成</span>`;
    }
    els.viewSub.innerHTML = `${escape(sub)}${danger}`;
  }

  function renderWeekStrip(today) {
    if (mode !== 'day') {
      els.weekStrip.innerHTML = '';
      return;
    }
    const start = addDays(selectedDate, -3);
    let html = '';
    for (let i = 0; i < 7; i += 1) {
      const key = addDays(start, i);
      const date = parseKey(key);
      const classes = ['week-day'];
      if (key === today) classes.push('is-today');
      if (key === selectedDate) classes.push('is-selected');
      html += `<button class="${classes.join(' ')}" type="button" data-date="${key}"><small>${WEEKDAY[date.getDay()]}</small><b>${date.getDate()}</b></button>`;
    }
    els.weekStrip.innerHTML = html;
  }

  /** 设定统计周期：自动纠正反向日期，并把跨度限制在 RANGE_MAX_DAYS 天内 */
  function applyRange(start, end, anchor) {
    if (!validKey(start) || !validKey(end)) return;
    let from = start;
    let to = end;
    if (from > to) {
      if (anchor === 'end') from = to;
      else to = from;
    }
    if (daysBetween(from, to) > RANGE_MAX_DAYS - 1) {
      if (anchor === 'end') from = addDays(to, -(RANGE_MAX_DAYS - 1));
      else to = addDays(from, RANGE_MAX_DAYS - 1);
    }
    rangeStart = from;
    rangeEnd = to;
  }

  function rangePreset(preset) {
    const today = todayKey();
    if (preset === 'month') {
      const base = parseKey(today);
      applyRange(
        dateKey(new Date(base.getFullYear(), base.getMonth(), 1)),
        dateKey(new Date(base.getFullYear(), base.getMonth() + 1, 0)),
        'end'
      );
      return;
    }
    const days = Number(preset);
    if (!Number.isFinite(days) || days < 1) return;
    applyRange(addDays(today, -(Math.min(days, RANGE_MAX_DAYS) - 1)), today, 'end');
  }

  const defaultRange = () => ({ start: addDays(todayKey(), -6), end: addDays(todayKey(), 7) });
  const formatSlash = key => {
    const date = parseKey(key);
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  };

  function openCalendar(field) {
    calField = field;
    calCursor = dateKey(startOfMonth(parseKey(field === 'start' ? rangeStart : rangeEnd)));
  }

  function shiftCalMonth(delta) {
    if (!calCursor) return;
    const base = parseKey(calCursor);
    calCursor = dateKey(new Date(base.getFullYear(), base.getMonth() + delta, 1));
  }

  /** 统计周期与克隆共用月份导航、42 格日期网格及选中样式。 */
  function pickerMonthInner(cursor, prefix, dayState) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const offset = (new Date(year, month, 1).getDay() + 6) % 7;
    const total = new Date(year, month + 1, 0).getDate();
    let cells = '';
    for (let i = 0; i < offset; i += 1) cells += '<span class="pk-blank" aria-hidden="true"></span>';
    for (let day = 1; day <= total; day += 1) {
      const key = `${year}-${pad(month + 1)}-${pad(day)}`;
      const state = dayState(key);
      const classes = ['pk-day'];
      if (state.selected) classes.push('is-selected');
      else if (state.inRange) classes.push('in-range');
      if (state.edge) classes.push('is-edge');
      if (state.disabled) classes.push('is-off');
      const label = `${year} 年 ${month + 1} 月 ${day} 日`;
      cells += `<button class="${classes.join(' ')}" type="button" data-${prefix}-day="${key}" aria-label="${label}" aria-pressed="${Boolean(state.selected)}"${state.disabled ? ' disabled' : ''}>${day}</button>`;
    }
    // 无论大小月都补满 6 周（42 格）：不同月份行数在 4~6 行之间变化，
    // 会让弹层高度随翻月跳动；尾部用空格补齐后日历高度恒定
    for (let i = offset + total; i < 42; i += 1) cells += '<span class="pk-blank" aria-hidden="true"></span>';
    return `<div class="pk-nav">
        <button class="pk-arrow" type="button" data-${prefix}-nav="-1" aria-label="上个月"><svg class="icon"><use href="#i-chevron-left"></use></svg></button>
        <span class="pk-month">${year}年${month + 1}月</span>
        <button class="pk-arrow" type="button" data-${prefix}-nav="1" aria-label="下个月"><svg class="icon"><use href="#i-chevron-right"></use></svg></button>
      </div>
      <div class="pk-weekdays" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
      <div class="pk-grid" data-picker-month="${year}-${pad(month + 1)}">${cells}</div>`;
  }

  /** 自绘日历：月份导航 + 日期网格 + 清除/今天，样式完全由页面控制 */
  function calendarInner(today) {
    const cursor = calCursor ? parseKey(calCursor) : startOfMonth(parseKey(today));
    const editingStart = calField !== 'end';
    const selected = editingStart ? rangeStart : rangeEnd;
    return `<div class="pk-head">
        <p class="pk-caption">选择${editingStart ? '开始' : '结束'}日期</p>
        <button class="pk-back" type="button" data-cal-action="back">返回</button>
      </div>
      ${pickerMonthInner(cursor, 'cal', key => ({
        selected: key === selected,
        inRange: key > rangeStart && key < rangeEnd,
        edge: key !== selected && (key === rangeStart || key === rangeEnd),
        disabled: editingStart ? key > rangeEnd : key < rangeStart
      }))}
      <div class="pk-foot">
        <button class="pk-clear" type="button" data-cal-action="clear" title="恢复默认的 14 天周期">清除</button>
        <button class="pk-today" type="button" data-cal-action="today" title="选中今天">今天</button>
      </div>`;
  }

  function rangeFieldsInner(today) {
    const dayCount = daysBetween(rangeStart, rangeEnd) + 1;
    const base = parseKey(today);
    const monthStart = dateKey(new Date(base.getFullYear(), base.getMonth(), 1));
    const monthEnd = dateKey(new Date(base.getFullYear(), base.getMonth() + 1, 0));
    const presetActive = {
      7: rangeEnd === today && rangeStart === addDays(today, -6),
      14: rangeEnd === today && rangeStart === addDays(today, -13),
      30: rangeEnd === today && rangeStart === addDays(today, -29),
      month: rangeStart === monthStart && rangeEnd === monthEnd
    };
    return `<p class="range-pop-title">统计周期<small>共 ${dayCount} 天</small></p>
      <div class="range-fields">
        <div class="range-field">
          <span class="range-field-label">开始日期</span>
          <span class="date-field">
            <span class="date-text">${formatSlash(rangeStart)}</span>
            <button class="date-pick" type="button" data-open-cal="start" aria-label="选择统计开始日期"><svg class="icon"><use href="#i-calendar"></use></svg></button>
          </span>
        </div>
        <span class="range-dash" aria-hidden="true">—</span>
        <div class="range-field">
          <span class="range-field-label">结束日期</span>
          <span class="date-field">
            <span class="date-text">${formatSlash(rangeEnd)}</span>
            <button class="date-pick" type="button" data-open-cal="end" aria-label="选择统计结束日期"><svg class="icon"><use href="#i-calendar"></use></svg></button>
          </span>
        </div>
      </div>
      <div class="range-presets">
        <button type="button" data-range-preset="7" class="${presetActive[7] ? 'is-active' : ''}">过去7天</button>
        <button type="button" data-range-preset="14" class="${presetActive[14] ? 'is-active' : ''}">过去14天</button>
        <button type="button" data-range-preset="30" class="${presetActive[30] ? 'is-active' : ''}">过去30天</button>
        <button type="button" data-range-preset="month" class="${presetActive.month ? 'is-active' : ''}">本月</button>
      </div>
      <div class="range-foot"><span class="range-hint">最多可选 ${RANGE_MAX_DAYS} 天</span><button class="range-done" type="button" data-action="close-range">完成</button></div>`;
  }

  const rangePopInner = today => (calField ? calendarInner(today) : rangeFieldsInner(today));

  // 只刷新弹层内容：翻月时不重建整个总览，避免弹层入场动画反复播放
  function renderRangePop() {
    const pop = $('.range-pop', els.overviewContent);
    if (pop) pop.innerHTML = rangePopInner(todayKey());
  }

  function renderOverview(today) {
    if (!todos.length) {
      els.overviewContent.innerHTML = `
        <section class="onboard">
          <div class="onboard-copy">
            <h2>还没有发布待办</h2>
            <button class="primary-btn" type="button" data-action="new">写第一条待办</button>
          </div>
          <svg class="onboard-art" viewBox="0 0 260 200" fill="none" aria-hidden="true">
            <rect x="67" y="26" width="126" height="156" rx="12" fill="var(--surface)" stroke="var(--line-strong)"/>
            <rect x="96" y="16" width="68" height="21" rx="7" fill="var(--accent-soft)" stroke="var(--accent)"/>
            <circle cx="85" cy="64" r="7.5" stroke="var(--accent)" stroke-width="2"/>
            <path d="m81.5 64 2.6 2.6 4.2-5" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M101 64h64M101 84h48M101 104h57M101 124h38" stroke="var(--line-strong)" stroke-width="2.5" stroke-linecap="round"/>
            <circle cx="85" cy="124" r="7.5" stroke="var(--line-strong)" stroke-width="2"/>
            <rect x="170" y="132" width="58" height="34" rx="8" fill="var(--mark-soft)" stroke="var(--mark-line)"/>
            <path d="M181 149h34" stroke="var(--mark)" stroke-width="2.5" stroke-linecap="round"/>
            <path d="m186 46 10-10 20 20-10 10-22 4 2-24Z" fill="var(--surface-2)" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
          </svg>
        </section>`;
      return;
    }

    const stats = countStats(today);
    const todayCount = stats.todayTasks.length;
    const todayDone = stats.todayDone;
    const maxOverdue = stats.overdue.length ? Math.max(...stats.overdue.map(overdueDays)) : 0;
    const weekDelta = stats.completedThisWeek - stats.completedLastWeek;
    const highlightCount = stats.highlightedTodos.length;

    const dayCount = daysBetween(rangeStart, rangeEnd) + 1;
    const chartDays = Array.from({ length: dayCount }, (_, index) => addDays(rangeStart, index));
    const chartData = chartDays.map(key => {
      const list = tasksForDate(key);
      const done = list.filter(todo => todo.done).length;
      const overdue = key < today ? list.filter(todo => !todo.done).length : 0;
      const planned = list.length - done - overdue;
      return { key, total: list.length, done, overdue, planned };
    });
    const chartMax = Math.max(1, ...chartData.map(day => day.total));
    const rangeTotal = chartData.reduce((sum, day) => sum + day.total, 0);
    const rangeDone = chartData.reduce((sum, day) => sum + day.done, 0);
    const rangeOverdue = chartData.reduce((sum, day) => sum + day.overdue, 0);
    const rangePlanned = chartData.reduce((sum, day) => sum + day.planned, 0);
    const rangeRate = rangeTotal ? Math.round(rangeDone / rangeTotal * 100) : 0;
    const rangeNote = rangeTotal
      ? `周期内共 ${rangeTotal} 项 · 已完成 ${rangeDone} 项（${rangeRate}%）· 超期 ${rangeOverdue} 项 · 待办 ${rangePlanned} 项`
      : '这个周期内还没有安排待办';

    const chartHtml = chartData.map(day => {
      const date = parseKey(day.key);
      const isToday = day.key === today;
      const height = day.total ? Math.max(4, (day.total / chartMax) * 100) : 0;
      const doneH = day.total ? day.done / day.total * 100 : 0;
      const overdueH = day.total ? day.overdue / day.total * 100 : 0;
      const plannedH = day.total ? day.planned / day.total * 100 : 0;
      const label = `${formatShort(day.key)}：完成 ${day.done}，未完成 ${day.total - day.done}${day.overdue ? `，其中超期 ${day.overdue}` : ''}`;
      const dayText = isToday ? '今天' : `周${WEEKDAY_SHORT[date.getDay()]}`;
      const classes = ['chart-col'];
      if (isToday) classes.push('is-today');
      return `<button class="${classes.join(' ')}" type="button" data-date="${day.key}" title="${escape(label)}" aria-label="${escape(label)}">
        <span class="chart-track"><span class="bar-stack" style="height:${height}%">${doneH ? `<i class="seg done" style="height:${doneH}%"></i>` : ''}${overdueH ? `<i class="seg overdue" style="height:${overdueH}%"></i>` : ''}${plannedH ? `<i class="seg planned" style="height:${plannedH}%"></i>` : ''}</span></span>
        <span class="chart-day">${dayText}</span>
        <span class="chart-num">${date.getDate()}</span>
      </button>`;
    }).join('');

    const rangePickerHtml = `<div class="range-picker">
      <button class="range-trigger" type="button" data-action="toggle-range" aria-expanded="${rangeOpen ? 'true' : 'false'}" aria-haspopup="dialog" aria-controls="range-pop">
        <svg class="icon"><use href="#i-calendar"></use></svg>
        <span class="range-trigger-text">选择统计周期</span>
        <span class="range-trigger-value">${escape(formatRangeCompact(rangeStart, rangeEnd))}</span>
        <svg class="icon range-chevron"><use href="#i-chevron-right"></use></svg>
      </button>
      ${rangeOpen ? `<div class="range-pop" id="range-pop" role="dialog" aria-label="选择统计周期">${rangePopInner(today)}</div>` : ''}
    </div>`;

    // 超期与重点共用同一套卡片结构：顶部标签 + 标题 + 底部时间，两个栏目布局天然对齐
    const overdueHtml = stats.overdue.length ? `
      <div class="overview-grid">
        ${stats.overdue.slice(0, 5).map(todo => `<button class="overview-card is-overdue" type="button" data-date="${todo.date}">
          ${todo.highlighted ? '<svg class="icon overview-star"><use href="#i-star"></use></svg>' : ''}
          <span class="overview-badge">超期 ${overdueDays(todo)} 天</span>
          <span class="overview-text">${escape(todo.title)}</span>
          <span class="overview-meta">计划 ${formatShort(todo.date)}</span>
        </button>`).join('')}
      </div>
      ${stats.overdue.length > 5 ? `<button class="panel-foot-link" type="button" data-action="today">还有 ${stats.overdue.length - 5} 项，去今天查看<svg class="icon"><use href="#i-arrow"></use></svg></button>` : ''}
    ` : `<div class="overdue-empty"><svg class="icon"><use href="#i-check"></use></svg><span>没有超期事项</span></div>`;

    const highlightItems = stats.highlightedTodos
      .map(todo => ({ todo, text: todo.title, createdAt: todo.createdAt }))
      .sort((a, b) => a.todo.date.localeCompare(b.todo.date) || b.createdAt.localeCompare(a.createdAt));

    const highlightsHtml = highlightItems.length ? `<div class="overview-grid">${highlightItems.map(item => {
      const overdue = isOverdue(item.todo);
      const badge = item.todo.done ? '已完成' : overdue ? `超期 ${overdueDays(item.todo)} 天` : '待办';
      return `<button class="overview-card is-highlight" type="button" data-todo-id="${item.todo.id}">
        <span class="overview-badge${overdue ? ' badge-overdue' : ''}">${badge}</span>
        <span class="overview-text">${escape(item.text)}</span>
        <span class="overview-meta">${item.todo.done ? formatShort(item.todo.date) : `计划 ${formatShort(item.todo.date)}`}</span>
      </button>`;
    }).join('')}</div>` : '<div class="highlight-empty"><svg class="icon"><use href="#i-star"></use></svg><span>没有重点标注的待办</span></div>';

    els.overviewContent.innerHTML = `
      <div class="stats">
        <article class="stat-card">
          <div class="stat-main">
            <p class="stat-label">今日进度</p>
            <p class="stat-value">${todayDone}<small> / ${todayCount} 项</small></p>
            <p class="stat-sub">${todayCount ? (todayDone === todayCount ? '今天已全部完成' : `还剩 ${todayCount - todayDone} 项`) : '今天还没有安排'}</p>
          </div>
        </article>
        <article class="stat-card ${stats.overdue.length ? 'is-danger' : ''}">
          <div class="stat-main">
            <p class="stat-label">超期未完成</p>
            <p class="stat-value">${stats.overdue.length}<small> 项</small></p>
            <p class="stat-sub">${stats.overdue.length ? `最久已超期 ${maxOverdue} 天` : '没有超期'}</p>
          </div>
        </article>
        <article class="stat-card is-done">
          <div class="stat-main">
            <p class="stat-label">本周完成</p>
            <p class="stat-value">${stats.completedThisWeek}<small> 项</small></p>
            <p class="stat-sub">较上周 ${weekDelta >= 0 ? '+' : ''}${weekDelta} · 完成率 ${stats.weekRate}%</p>
          </div>
        </article>
        <article class="stat-card is-highlight">
          <div class="stat-main">
            <p class="stat-label">重点标记</p>
            <p class="stat-value">${highlightCount}<small> 条</small></p>
            <p class="stat-sub">${stats.highlightedTodos.length} 条待办</p>
          </div>
        </article>
      </div>

      <div class="dash-grid">
        <section class="panel chart-panel">
          <div class="panel-head">
            <div class="panel-head-main">
              <h2 class="panel-title">周期总览 <small>共 ${dayCount} 天</small></h2>
              ${rangePickerHtml}
            </div>
            <div class="legend"><span><i class="done"></i>已完成</span><span><i class="planned"></i>待办</span><span><i class="overdue"></i>超期</span></div>
          </div>
          <div class="chart">${chartHtml}</div>
          <p class="chart-note">${rangeNote}</p>
        </section>

        <section class="panel overdue-panel">
          <div class="panel-head">
            <h2 class="panel-title">超期情况 <small>${stats.overdue.length} 项</small></h2>
          </div>
          ${overdueHtml}
        </section>
      </div>

      <section class="panel highlights-panel">
        <div class="panel-head">
          <h2 class="panel-title">重点标记 <small>${highlightCount} 条</small></h2>
        </div>
        ${highlightsHtml}
      </section>`;
  }

  function taskHTML(todo, today, options) {
    const settings = options || {};
    const overdue = isOverdue(todo);
    const days = overdue ? overdueDays(todo) : 0;
    const isExpanded = expanded.has(todo.id);
    const notesId = `notes-${todo.id}`;
    const notesHtml = todo.notes.length
      ? todo.notes.map(note => `<article class="note" data-note-id="${note.id}">
          <p class="note-text"><span class="mark">${escape(note.text)}</span></p>
          <div class="note-foot">
            <time class="note-time" datetime="${note.createdAt}" title="${escape(formatTime(note.createdAt))}">${escape(formatTime(note.createdAt))}</time>
            <div class="note-tools">
              <button class="tool-btn" type="button" data-action="note-delete" title="删除这条备注" aria-label="删除这条备注"><svg class="icon"><use href="#i-trash"></use></svg></button>
            </div>
          </div>
        </article>`).join('')
      : '<p class="notes-empty">还没有备注，写下进展或提醒</p>';

    // 完成后不再显示「完成于 …」，completedAt 仍保留在数据里，用于总览的本周完成统计
    const metaParts = [];
    if (overdue) {
      metaParts.push(`<span class="task-origin">原定 ${formatShort(todo.date)}</span>`);
    } else if (settings.showDate) {
      const dateText = todo.date === today
        ? '今天'
        : (todo.date.slice(0, 4) === today.slice(0, 4) ? formatShort(todo.date) : `${todo.date.slice(0, 4)}.${formatShort(todo.date)}`);
      metaParts.push(`<span class="task-date" title="${escape(formatFull(todo.date))}">${escape(dateText)}</span>`);
    }

    const noteHint = todo.notes.length ? '<span class="task-note-hint">有备注</span>' : '';
    const metaHtml = metaParts.length ? `<div class="task-meta">${metaParts.join('')}</div>` : '';
    const noteLabel = todo.notes.length ? `查看 ${todo.notes.length} 条备注` : '添加备注';

    return `<article class="task ${todo.done ? 'is-done' : ''} ${todo.highlighted ? 'is-highlighted' : ''} ${overdue ? 'is-overdue' : ''}" data-id="${todo.id}">
      <button class="check" type="button" role="checkbox" aria-checked="${todo.done}" aria-label="${todo.done ? '标记为未完成' : '标记为完成'}" data-action="toggle">
        <svg class="icon"><use href="#i-check"></use></svg>
      </button>
      <div class="task-main">
        <div class="task-head">
          <span class="task-title" title="双击重命名"><span class="mark">${escape(todo.title)}</span>${noteHint}</span>
          ${overdue ? `<span class="task-badge overdue">超期 ${days} 天</span>` : ''}
        </div>
        ${metaHtml}
      </div>
      <div class="notes-panel${isExpanded ? ' is-open' : ''}" id="${notesId}">
        <div class="notes-clip">
          ${notesHtml}
          <form class="note-add" data-id="${todo.id}">
            <textarea rows="1" maxlength="2000" aria-label="追加备注"></textarea>
            <button class="note-send" type="submit" aria-label="添加备注"><svg class="icon"><use href="#i-arrow"></use></svg></button>
          </form>
        </div>
      </div>
      <div class="task-tools">
        <button class="tool-btn ${todo.highlighted ? 'is-active' : ''}" type="button" data-action="highlight" title="标为重点" aria-label="标为重点" aria-pressed="${todo.highlighted}"><svg class="icon"><use href="#i-star"></use></svg></button>
        <button class="tool-btn ${todo.notes.length ? 'has-notes' : ''}" type="button" data-action="expand" title="${noteLabel}" aria-label="${noteLabel}" aria-expanded="${isExpanded}" aria-controls="${notesId}"><svg class="icon"><use href="#i-note"></use></svg></button>
        <button class="tool-btn" type="button" data-action="move-day" title="移动到某一天" aria-label="移动到某一天"><svg class="icon"><use href="#i-calendar"></use></svg></button>
        <button class="tool-btn" type="button" data-action="menu" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded="${menuOpen === todo.id}"><svg class="icon"><use href="#i-more"></use></svg></button>
      </div>
      <div class="task-menu ${menuOpen === todo.id ? 'is-open' : ''}" role="menu">
        <button type="button" role="menuitem" data-action="clone">克隆</button>
        <button type="button" role="menuitem" data-action="edit">重命名该待办</button>
        <button type="button" role="menuitem" data-action="move">移动到分组</button>
        <button class="danger" type="button" role="menuitem" data-action="delete">删除</button>
      </div>
    </article>`;
  }

  function renderDay(today) {
    const list = tasksForDate(selectedDate);
    const total = list.length;
    const overdue = selectedDate === today ? overdueTodos() : [];

    updateDaySummary(today);

    // 有超期时默认只保留标题行、列表收起；顶部汇总文字仍按真实的超期数计算，这里只决定区块本身显不显示
    if (!overdue.length) overdueOpen = false;
    els.overdueBlock.innerHTML = overdueBlockHtml(today, overdue);

    // 全部完成的提示只放在顶部汇总（4 / 4 已完成 · 全部完成），列表里不再单独插一条横幅
    let html = '';

    // 分组跨日期存在，但只在这一天真的有该分组的待办时才建块——避免空分组在每一天都留个空壳
    const ungrouped = list.filter(todo => !todo.groupId);
    const groupSections = groups
      .map(group => ({ id: group.id, name: group.name, tasks: list.filter(todo => todo.groupId === group.id) }))
      .filter(section => section.tasks.length);

    // 当天只要还有不带分组的待办，「未分组」组头就一直显示（不再依赖是否还有其他分组）；
    // 一条待办都没有时不建任何组块，交给下方空态提示
    const sections = ungrouped.length
      ? [{ id: null, name: '未分组', tasks: ungrouped }, ...groupSections]
      : groupSections;
    if (sections.length) {
      html += `<div class="group-stack">${sections.map(section => groupSectionHTML(section, today)).join('')}</div>`;
    }
    els.taskList.innerHTML = html;
    els.dayEmpty.hidden = total > 0;
    // 若刚刚删掉了这一天的最后一条待办，空态提示在塌缩收尾处上浮淡入
    playDayEmptyEnter(els.dayEmpty);
  }

  function sortGroupTasks(list) {
    return list.slice().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.done) return String(b.completedAt || b.updatedAt).localeCompare(String(a.completedAt || a.updatedAt));
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  function renderGroups(today) {
    const sections = groups.map(group => ({
      id: group.id,
      name: group.name,
      tasks: todos.filter(todo => todo.groupId === group.id)
    }));
    // 未分组是固定模块，即使没有待办也保留，方便用户确认这里没有遗漏事项
    sections.push({ id: null, name: '未分组', tasks: todos.filter(todo => !todo.groupId) });
    // 组内没有待办时只留组头，不渲染任何占位文案
    const panelSelector = '.groups-sections > .group-panel';
    const panelKey = panel => panel.dataset.groupId || 'ungrouped';
    const prevHeights = capturePanelHeights(els.groupsContent, panelSelector, panelKey);
    els.groupsContent.innerHTML = `<div class="groups-sections">${sections.map(section => groupSectionHTML(section, today, {
      panel: true,
      showDate: true,
      acrossDates: true
    })).join('')}</div>`;
    animatePanelShrink(els.groupsContent, panelSelector, panelKey, prevHeights);
  }

  function groupSectionHTML(section, today, options) {
    const settings = options || {};
    const sorter = settings.acrossDates ? sortGroupTasks : sortTasks;
    const doneCount = section.tasks.filter(todo => todo.done).length;
    const headAttrs = section.id ? ` data-group-id="${section.id}"` : '';
    // 分组视图是唯一的分组编辑入口（组名可点开重命名、右侧三点提供重命名/删除）；
    // 单日视图的组名只作只读展示——不渲染按钮，也不渲染三点菜单
    const editable = Boolean(settings.panel);
    const more = section.id && editable
      ? `<button class="group-more" type="button" data-action="group-menu" data-group-id="${section.id}" title="更多操作" aria-label="更多操作 ${escape(section.name)}" aria-haspopup="menu" aria-expanded="${groupMenuOpen === section.id}"><svg class="icon"><use href="#i-more"></use></svg></button>`
      : '';
    // 分组菜单与待办条的 .task-menu 同款：纯文字项、无图标，「删除」红色
    const menu = section.id && editable
      ? `<div class="group-menu ${groupMenuOpen === section.id ? 'is-open' : ''}" role="menu">
        <button type="button" role="menuitem" data-action="group-rename" data-group-id="${section.id}">重命名分组</button>
        <button class="danger" type="button" role="menuitem" data-action="group-delete" data-group-id="${section.id}">删除</button>
      </div>`
      : '';
    const count = (section.tasks.length || settings.panel) ? `<span class="group-count">${doneCount} / ${section.tasks.length}</span>` : '';
    const nameEl = section.id
      ? (editable
        ? `<button class="group-name" type="button" data-action="group-edit" data-group-id="${section.id}" title="点击重命名">${escape(section.name)}</button>`
        : `<h3 class="group-name">${escape(section.name)}</h3>`)
      : `<h3 class="group-name is-plain">${escape(section.name)}</h3>`;
    const taskOptions = { showDate: Boolean(settings.showDate) };
    // 已完成项由排序函数自然排在未完成项之后连续展示（排序第一键即完成状态）：
    // 不按完成状态拆分渲染、不插入任何自动生成的「已完成」分区，
    // 全站任何页面、状态和入口都不会出现自动创建的「已完成」分组
    const items = sorter(section.tasks);
    // 没有待办时整块正文不渲染（不留占位文案）；组块本身仍由组头代表
    const body = section.tasks.length
      ? `<div class="task-list">${items.map(todo => taskHTML(todo, today, taskOptions)).join('')}</div>`
      : '';
    const classes = ['group-block'];
    if (!section.tasks.length) classes.push('is-empty');
    if (settings.panel) classes.push('group-panel');
    return `<section class="${classes.join(' ')}"${headAttrs}>
      <header class="group-head">
        ${nameEl}
        ${count}
        ${more}
      </header>
      ${body}
      ${menu}
    </section>`;
  }

  // 内容整块替换会立刻改变页面高度。若先渲染再发起平滑滚动，浏览器会先把 scrollTop
  // 夹到新高度允许的上限（一帧内的硬跳，可能几百像素），平滑动画再从被夹住的位置补到顶部，
  // 观感就是「先跳一下、再滑一下」的二次位移。所以渲染后先确认滚动位置有没有被浏览器夹走：
  // 被夹过就直接归零（与内容替换合成同一次位移），只有高度没变、位置没被夹时才保留平滑滚动。
  function scrollToTop(prevY) {
    if (!prevY) return;
    // 读一次 scrollHeight 强制完成布局，保证拿到夹取之后的真实位置
    void document.documentElement.scrollHeight;
    const clamped = Math.abs(window.scrollY - prevY) > 0.5;
    window.scrollTo({ top: 0, left: 0, behavior: clamped ? 'auto' : 'smooth' });
  }

  function goDay(key, options) {
    if (!validKey(key)) return;
    const settings = options || {};
    // 切换方向：目标日期更晚 → 从右滑入；更早 → 从左滑入；同日重进不带方向
    const dayDir = key === selectedDate ? null : (key > selectedDate ? 'fwd' : 'back');
    const switchingView = mode !== 'day';
    const prevScrollY = window.scrollY;
    selectedDate = key;
    mode = 'day';
    rangeOpen = false;
    calField = null;
    calendarCursor = startOfMonth(parseKey(key));
    expanded.clear();
    closeMenu();
    closeDrawer();
    // 单日之间切日期：方向滑动 + 卡片交错入场；
    // 跨视图进入单日直接渲染，不做任何过渡动画
    if (!switchingView) {
      staggerNext = true;
      if (dayDir) applyDayDirection(dayDir);
    }
    renderAll();
    if (settings.scroll !== false) scrollToTop(prevScrollY);
  }

  function goOverview() {
    const prevScrollY = window.scrollY;
    mode = 'overview';
    expanded.clear();
    closeMenu();
    closeDrawer();
    renderAll();
    scrollToTop(prevScrollY);
  }

  function goGroups() {
    const prevScrollY = window.scrollY;
    mode = 'groups';
    rangeOpen = false;
    calField = null;
    expanded.clear();
    closeMenu();
    closeDrawer();
    renderAll();
    scrollToTop(prevScrollY);
  }

  function goTrash() {
    const prevScrollY = window.scrollY;
    mode = 'trash';
    rangeOpen = false;
    calField = null;
    expanded.clear();
    closeMenu();
    closeDrawer();
    renderAll();
    scrollToTop(prevScrollY);
  }

  function toggleDone(id) {
    const todo = findTodo(id);
    if (!todo) return;
    const card = $(`.task[data-id="${id}"]`);
    todo.done = !todo.done;
    todo.completedAt = todo.done ? new Date().toISOString() : null;
    todo.updatedAt = new Date().toISOString();
    save();
    closeMenu();
    // 原地切换完成态：文字变浅与删除线画出由 transition 双向驱动，取消时以相同节奏反向回退；
    // 不重渲染列表，卡片位置保持不变（切换视图/日期后才按完成状态重新排序）
    if (card) {
      card.classList.toggle('is-done', todo.done);
      const checkBtn = $('.check', card);
      if (checkBtn) {
        checkBtn.setAttribute('aria-checked', String(todo.done));
        checkBtn.setAttribute('aria-label', todo.done ? '标记为未完成' : '标记为完成');
      }
      updateCardMeta(card, todo);
    }
    refreshAfterToggle();
  }

  function toggleHighlight(id) {
    const todo = findTodo(id);
    if (!todo) return;
    const card = $(`.task[data-id="${id}"]`);
    todo.highlighted = !todo.highlighted;
    todo.updatedAt = new Date().toISOString();
    save();
    closeMenu();
    // 原地切换星标：按钮底色、图标填充与卡片染紫由放慢的过渡平滑衔接，列表不重渲染
    if (card) {
      card.classList.toggle('is-highlighted', todo.highlighted);
      const star = $('[data-action="highlight"]', card);
      if (star) {
        star.classList.toggle('is-active', todo.highlighted);
        star.setAttribute('aria-pressed', String(todo.highlighted));
      }
    }
  }

  function toggleExpand(id) {
    closeMenu();
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    // 原地展开/收起备注面板（像素高度过渡），不重渲染列表
    const card = $(`.task[data-id="${id}"]`);
    const panel = card ? $('.notes-panel', card) : null;
    if (!card || !panel) {
      renderAll();
      return;
    }
    const open = expanded.has(id);
    const textarea = $('.note-add textarea', panel);
    if (textarea) autoGrow(textarea);
    setPanelOpen(panel, open);
    $$('[data-action="expand"]', card).forEach(btn => btn.setAttribute('aria-expanded', String(open)));
  }

  function toggleMenu(id) {
    if (menuOpen === id) {
      closeMenu();
      return;
    }
    closeGroupMenus();
    menuOpen = id;
    $$('.task').forEach(task => {
      const open = task.dataset.id === id;
      const menu = $('.task-menu', task);
      const button = $('[data-action="menu"]', task);
      if (menu && button && open) {
        const taskRect = task.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        menu.classList.add('is-open');
        document.body.classList.add('menu-open');
        menu.style.top = 'auto';
        menu.style.bottom = 'auto';
        const menuHeight = menu.offsetHeight;
        const spaceBelow = window.innerHeight - buttonRect.bottom;
        const spaceAbove = buttonRect.top;
        // 底部空间不足且上方更宽裕时，菜单改为向上展开，避免被视口或悬浮按钮遮住；
        // 方向同步给 CSS：弹出动画从按钮一侧长出（transform-origin 上/下切换）
        const opensUp = spaceBelow < menuHeight + 12 && spaceAbove > spaceBelow;
        if (opensUp) {
          menu.style.bottom = `${Math.round(taskRect.bottom - buttonRect.top + 5)}px`;
        } else {
          menu.style.top = `${Math.round(buttonRect.bottom - taskRect.top + 5)}px`;
        }
        menu.classList.toggle('opens-up', opensUp);
      }
      if (menu) menu.classList.toggle('is-open', open);
      if (button) button.setAttribute('aria-expanded', String(open));
    });
  }

  function closeGroupMenus() {
    groupMenuOpen = null;
    $$('.group-menu.is-open').forEach(menu => menu.classList.remove('is-open'));
    $$('[data-action="group-menu"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }

  function closeMenu() {
    menuOpen = null;
    document.body.classList.remove('menu-open');
    $$('.task-menu.is-open').forEach(menu => menu.classList.remove('is-open'));
    $$('[data-action="menu"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    closeGroupMenus();
  }

  // 分组三点按钮的下拉菜单：垂直定位逻辑与 toggleMenu 一致（默认贴按钮下方，
  // 底部空间不足且上方更宽裕时改为向上）；水平方向按按钮右缘动态对齐，
  // 兼容单日视图（组头贴边）与分组视图（面板有内边距）两种容器
  function toggleGroupMenu(id, buttonEl) {
    if (groupMenuOpen === id) {
      closeMenu();
      return;
    }
    closeMenu();
    const block = buttonEl.closest('.group-block');
    const menu = block ? $('.group-menu', block) : null;
    if (!block || !menu) return;
    groupMenuOpen = id;
    menu.classList.add('is-open');
    document.body.classList.add('menu-open');
    buttonEl.setAttribute('aria-expanded', 'true');
    const blockRect = block.getBoundingClientRect();
    const buttonRect = buttonEl.getBoundingClientRect();
    menu.style.top = 'auto';
    menu.style.bottom = 'auto';
    // 菜单右缘比按钮右缘再探出 2px，与待办条菜单（13px 菜单 / 15px 按钮缘）的错位关系一致
    menu.style.right = `${Math.max(1, Math.round(blockRect.right - buttonRect.right - 2))}px`;
    const menuHeight = menu.offsetHeight;
    const spaceBelow = window.innerHeight - buttonRect.bottom;
    const spaceAbove = buttonRect.top;
    const opensUp = spaceBelow < menuHeight + 12 && spaceAbove > spaceBelow;
    if (opensUp) {
      menu.style.bottom = `${Math.round(blockRect.bottom - buttonRect.top + 5)}px`;
    } else {
      menu.style.top = `${Math.round(buttonRect.bottom - blockRect.top + 5)}px`;
    }
    menu.classList.toggle('opens-up', opensUp);
  }

  function addNote(id, text) {
    const todo = findTodo(id);
    if (!todo) return;
    const content = String(text || '').trim().slice(0, 2000);
    if (!content) return;
    todo.notes.push({ id: uid(), text: content, createdAt: new Date().toISOString() });
    todo.updatedAt = new Date().toISOString();
    noteFocusId = id;
    save();
    renderAll();
  }

  function deleteNote(id, noteId) {
    const todo = findTodo(id);
    if (!todo) return;
    const index = todo.notes.findIndex(note => note.id === noteId);
    if (index < 0) return;
    todo.notes.splice(index, 1);
    todo.updatedAt = new Date().toISOString();
    save();
    expanded.add(id);
    renderAll();
  }

  // 删除只是把待办移入回收站，随时可以恢复；彻底删除在回收站里单独确认操作
  function deleteTodo(id) {
    const index = todos.findIndex(todo => todo.id === id);
    if (index < 0) return;
    const card = $(`.task[data-id="${id}"]`);
    const [todo] = todos.splice(index, 1);
    todo.deletedAt = new Date().toISOString();
    trashTodos.unshift(todo);
    expanded.delete(id);
    save();
    closeMenu();
    // 这一天被删空了：登记空态入场意图，等卡片（若为组内最后一条，还有组头）收干净、
    // 重渲染时再由 renderDay 接一段上浮淡入，不让空态提示在塌缩末尾突然落下
    if (mode === 'day' && !tasksForDate(selectedDate).length) dayEmptyEnterPending = true;
    // 数据已在点击时更新，计数也在退出动画开始时同步，避免与末尾重渲染叠加成一个视觉事件
    renderSidebar(todayKey());
    if (mode === 'day') updateDaySummary(todayKey());
    // 删掉的是某个分组当天的最后一条待办：该组块会在重渲染里整体消失。
    // 待办卡照旧塌缩，组头（分组名与下缘分隔线）以同一节奏同步收起，
    // 两者都结束再重渲染——组的外壳与卡片一起收干净，收尾处不再单独跳一下
    const block = mode === 'day' && card ? card.closest('.group-block') : null;
    if (block && $$('.task', block).length === 1) {
      let pending = 2;
      const done = () => {
        pending -= 1;
        if (pending === 0) renderAll();
      };
      animateExit(card, done);
      animateGroupHead(block, done);
      return;
    }
    // 分组视图：删掉组内最后一条待办时，组头下方的留白与卡片一起收拢，
    // 面板高度一步走到空组，卡片收干净后不再额外向上收一下
    if (mode === 'groups' && card) {
      const panel = card.closest('.group-panel');
      if (panel && $$('.task', panel).length === 1) collapseHeadGap(panel);
    }
    animateExit(card, renderAll);
  }

  /* ---------------- 原地状态切换的轻量刷新 ---------------- */

  // 原地同步卡片的超期外观：完成态移除红底、徽章与「原定 x.x」，取消完成时恢复。
  // 与 taskHTML 的生成逻辑保持一致（主列表无日期标签，分组视图带 showDate）
  function updateCardMeta(card, todo) {
    const main = $('.task-main', card);
    if (!main) return;
    const head = $('.task-head', main);
    const overdue = isOverdue(todo);
    card.classList.toggle('is-overdue', overdue);
    let badge = $('.task-badge', head);
    if (overdue && !badge) {
      head.insertAdjacentHTML('beforeend', `<span class="task-badge overdue">超期 ${overdueDays(todo)} 天</span>`);
    } else if (!overdue && badge) {
      badge.remove();
    }
    const showDate = Boolean(card.closest('.group-panel'));
    const parts = [];
    if (overdue) {
      parts.push(`<span class="task-origin">原定 ${formatShort(todo.date)}</span>`);
    } else if (showDate) {
      const dateText = todo.date === todayKey() ? '今天' : formatShort(todo.date);
      parts.push(`<span class="task-date" title="${escape(formatFull(todo.date))}">${escape(dateText)}</span>`);
    }
    const meta = $('.task-meta', main);
    if (parts.length) {
      if (meta) meta.innerHTML = parts.join('');
      else main.insertAdjacentHTML('beforeend', `<div class="task-meta">${parts.join('')}</div>`);
    } else if (meta) {
      meta.remove();
    }
  }

  // 日视图顶部汇总（x / x 已完成、文案、进度条）：renderAll 与原地勾选共用
  function updateDaySummary(today) {
    const list = tasksForDate(selectedDate);
    const done = list.filter(todo => todo.done).length;
    const total = list.length;
    const overdueOnDay = list.filter(isOverdue).length;
    const allDone = total > 0 && done === total;
    const overdue = selectedDate === today ? overdueTodos() : [];
    els.dayDone.textContent = String(done);
    els.dayTotal.textContent = `/ ${total} 已完成`;
    let note = total ? (allDone ? '全部完成' : `还有 ${total - done} 项未完成`) : '还没有待办';
    if (overdue.length) {
      if (!total) note = `今天还没有安排 · ${overdue.length} 项超期`;
      else if (allDone) note = `今天的安排已完成 · 仍有 ${overdue.length} 项超期`;
      else note = `还有 ${total - done} 项未完成 · ${overdue.length} 项超期`;
    }
    els.dayNote.textContent = note;
    els.dayNote.classList.toggle('is-danger', (selectedDate < today && overdueOnDay > 0) || overdue.length > 0);
    els.dayBar.style.transform = total ? `scaleX(${done / total})` : 'scaleX(0)';
  }

  // 勾选/取消完成后的轻量刷新：不重渲染列表（保住卡片位置与双向过渡），只同步侧栏、汇总与超期块
  function refreshAfterToggle() {
    const today = todayKey();
    renderSidebar(today);
    // 勾选是原地更新、列表不重排，但组头的「已完成 / 总数」要立刻反映结果
    syncGroupCounts();
    if (mode === 'day') {
      updateDaySummary(today);
      if (selectedDate === today) refreshOverdueBlock(today);
    }
  }

  // 原地同步可见组头的计数：卡片仍留在原位置（保持双向过渡），只改「已完成 / 总数」文字
  function syncGroupCounts() {
    const source = mode === 'groups' ? todos : mode === 'day' ? tasksForDate(selectedDate) : null;
    if (!source) return;
    $$('.group-block, .group-panel').forEach(block => {
      const countEl = $('.group-count', block);
      if (!countEl) return;
      const groupId = block.dataset.groupId || null;
      const list = source.filter(todo => (todo.groupId || null) === groupId);
      countEl.textContent = `${list.filter(todo => todo.done).length} / ${list.length}`;
    });
  }

  // 超期区块 HTML：列表包一层 grid-rows 容器，供原地展开/收拢动画使用（renderAll 与原地刷新共用）
  function overdueBlockHtml(today, overdue) {
    if (!overdue.length) return '';
    const listHtml = overdue.map(todo => taskHTML(todo, today)).join('');
    return `<section class="overdue-block" aria-label="超期未完成">
      <div class="overdue-head">
        <svg class="icon"><use href="#i-alert"></use></svg>
        <strong>超期未完成</strong><span>${overdue.length}</span>
        <div class="overdue-tools">
          <button class="tool-btn" type="button" data-action="overdue-toggle" aria-expanded="${overdueOpen}" title="${overdueOpen ? '收起超期列表' : '展开超期列表'}" aria-label="${overdueOpen ? '收起超期列表' : '展开超期列表'}"><svg class="icon"><use href="#i-eye${overdueOpen ? '-off' : ''}"></use></svg></button>
        </div>
      </div>
      ${overdueOpen ? `<div class="overdue-collapse is-open"><div class="task-list" id="overdue-list">${listHtml}</div></div>` : ''}
    </section>`;
  }

  // 原地同步超期块：勾选减少超期时只更新计数，最后一条超期完成则等原地动画播完再移除整块；
  // 取消完成产生新超期时补渲染整块（仅在今天的单日视图生效）
  function refreshOverdueBlock(today) {
    const overdue = overdueTodos();
    const block = $('.overdue-block', els.overdueBlock);
    if (!overdue.length) {
      if (block) {
        const count = $('.overdue-head span', block);
        if (count) count.textContent = '0';
        // 卡片的变浅/划线动画还在播，延迟移除让用户看到最后一次勾选的完整过程；
        // 期间若取消了勾选（超期重新出现），跳过移除
        setTimeout(() => {
          if (!overdueTodos().length) {
            overdueOpen = false;
            els.overdueBlock.innerHTML = '';
          }
        }, 450);
      }
      return;
    }
    if (!block) {
      els.overdueBlock.innerHTML = overdueBlockHtml(today, overdue);
      return;
    }
    const count = $('.overdue-head span', block);
    if (count) count.textContent = String(overdue.length);
  }

  // 超期块原地展开/收拢：像素高度过渡，不重渲染整个视图
  function toggleOverdueBlock() {
    overdueOpen = !overdueOpen;
    const block = $('.overdue-block', els.overdueBlock);
    if (!block) {
      renderAll();
      return;
    }
    const btn = $('[data-action="overdue-toggle"]', block);
    if (btn) {
      btn.setAttribute('aria-expanded', String(overdueOpen));
      btn.title = overdueOpen ? '收起超期列表' : '展开超期列表';
      const use = btn.querySelector('use');
      if (use) use.setAttribute('href', overdueOpen ? '#i-eye-off' : '#i-eye');
    }
    let collapse = $('.overdue-collapse', block);
    if (overdueOpen) {
      if (!collapse) {
        const listHtml = overdueTodos().map(todo => taskHTML(todo, todayKey())).join('');
        block.insertAdjacentHTML('beforeend', `<div class="overdue-collapse"><div class="task-list" id="overdue-list">${listHtml}</div></div>`);
        collapse = $('.overdue-collapse', block);
      }
      setPanelOpen(collapse, true);
    } else if (collapse) {
      // 快速重新展开会取消此次收尾；只有仍处于收起状态时才移除节点
      setPanelOpen(collapse, false, () => {
        if (!overdueOpen && collapse.isConnected) collapse.remove();
      });
    }
  }

  function syncGroupSelect(currentId) {
    const available = groups.length > 0;
    els.groupField.hidden = !available;
    els.groupSelect.innerHTML = ['<option value="">未分组</option>']
      .concat(groups.map(group => `<option value="${group.id}">${escape(group.name)}</option>`))
      .join('');
    els.groupSelect.value = currentId && groups.some(group => group.id === currentId) ? currentId : '';
  }

  function openCreate(date) {
    closeMenu();
    editingId = null;
    els.modalTitle.textContent = '添加一条待办';
    els.titleInput.value = '';
    dialogDate = validKey(date) ? date : selectedDate;
    syncGroupSelect(null);
    els.todoError.hidden = true;
    els.dialog.showModal();
    requestAnimationFrame(() => els.titleInput.focus());
  }

  function openEdit(id, options) {
    const todo = findTodo(id);
    if (!todo) return;
    editingId = id;
    els.modalTitle.textContent = '修改待办';
    els.titleInput.value = todo.title;
    dialogDate = todo.date;
    syncGroupSelect(todo.groupId);
    els.todoError.hidden = true;
    closeMenu();
    els.dialog.showModal();
    requestAnimationFrame(() => {
      els.titleInput.focus();
      // 双击文案进入时全选标题（输入即整体替换，符合重命名习惯）；
      // 菜单「重命名该待办」入口保持光标在末尾
      if (options && options.selectAll) els.titleInput.select();
      else els.titleInput.setSelectionRange(els.titleInput.value.length, els.titleInput.value.length);
    });
  }

  function closeDialog() {
    els.dialog.close();
    els.todoError.hidden = true;
  }

  function saveDialog() {
    const title = els.titleInput.value.trim();
    // 日期不在编辑弹窗内修改：新建沿用打开时的上下文日期，编辑保持原日期
    const date = dialogDate;
    if (!title) {
      els.todoError.textContent = '先写下要做的事';
      els.todoError.hidden = false;
      els.titleInput.focus();
      return;
    }
    const groupId = els.groupSelect.value || null;
    if (editingId) {
      const todo = findTodo(editingId);
      if (todo) {
        todo.title = title.slice(0, 200);
        todo.groupId = groupId && groups.some(group => group.id === groupId) ? groupId : null;
        todo.updatedAt = new Date().toISOString();
        save();
        closeDialog();
        if (mode === 'groups') renderAll();
        else goDay(date);
      } else {
        closeDialog();
      }
    } else {
      createTodo(title.slice(0, 200), date, groupId);
      closeDialog();
      if (mode === 'groups') renderAll();
      else goDay(date);
    }
  }

  function openTodo(id, noteId) {
    const todo = findTodo(id);
    if (!todo) return;
    // 从总览跳转属于切换界面：先清掉此前展开的详情，只保留刚点开的这一条
    expanded.clear();
    expanded.add(id);
    selectedDate = todo.date;
    mode = 'day';
    // 从总览卡片跳走时收起统计周期弹层，和 goDay 的离开行为保持一致，
    // 否则回到总览时弹层还挂着
    rangeOpen = false;
    calField = null;
    calendarCursor = startOfMonth(parseKey(todo.date));
    closeDrawer();
    renderAll();
    requestAnimationFrame(() => {
      const taskEl = $(`.task[data-id="${todo.id}"]`);
      if (!taskEl) return;
      if (noteId) {
        const noteEl = $(`.note[data-note-id="${noteId}"]`, taskEl);
        if (noteEl) {
          noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          noteEl.classList.add('is-flash');
          setTimeout(() => noteEl.classList.remove('is-flash'), 1200);
          return;
        }
      }
      taskEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
  }

  /* ---------------- 分组 ---------------- */

  const findGroup = id => groups.find(group => group.id === id);
  // 同名判定：忽略大小写与多余空白（「工作」「 工作 」算同名），中文不受影响
  const groupNameKey = name => String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toLowerCase();

  // 恢复分组时若撞名，自动在后面标序号：「工作」→「工作 (2)」→「工作 (3)」…
  // 原名本身带序号（如「会议 (2)」）时先剥掉再往上找，避免出现「会议 (2) (2)」；
  // 总长度仍受分组名 24 字上限约束，必要时从原名尾部截断
  function uniqueGroupName(rawName) {
    const name = String(rawName == null ? '' : rawName).trim().slice(0, 24);
    const taken = candidate => groups.some(group => groupNameKey(group.name) === groupNameKey(candidate));
    if (!taken(name)) return name;
    const tail = name.match(/^(.*?)\s*\((\d+)\)$/);
    const base = ((tail ? tail[1] : name).trim() || name).slice(0, 24);
    for (let index = 2; index <= 999; index += 1) {
      const suffix = ` (${index})`;
      const candidate = `${base.slice(0, Math.max(1, 24 - suffix.length))}${suffix}`;
      if (!taken(candidate)) return candidate;
    }
    return name;
  }

  function openGroupDialog(options) {
    const settings = options || {};
    groupDialogMode = settings.mode === 'rename' ? 'rename' : 'create';
    groupEditingId = groupDialogMode === 'rename' ? settings.groupId : null;
    groupPendingMoveId = settings.moveTodoId || null;
    groupPendingCreate = settings.createTodo || null;
    const group = groupEditingId ? findGroup(groupEditingId) : null;
    if (groupDialogMode === 'rename' && !group) return;
    els.groupTitle.textContent = groupDialogMode === 'rename' ? '重命名分组' : '新建分组';
    els.groupNameInput.value = group ? group.name : '';
    els.groupError.hidden = true;
    closeMenu();
    els.groupDialog.showModal();
    requestAnimationFrame(() => {
      els.groupNameInput.focus();
      els.groupNameInput.select();
    });
  }

  // 纯提示统一走弹窗：与「新建分组 / 移动分组 / 移动到哪一天」同一套 .modal.mini 外观。
  // 只有一段说明文字与一个确认按钮，Esc、右上角 ×、点击遮罩都能关闭
  function openNoticeDialog(text, title = '分组已创建') {
    if (!els.noticeDialog) return;
    els.noticeTitle.textContent = title;
    els.noticeText.textContent = text;
    els.noticeDialog.showModal();
  }

  function saveGroup() {
    const name = els.groupNameInput.value.trim().slice(0, 24);
    let standaloneGroup = null;
    if (!name) {
      els.groupError.textContent = '先写个分组名';
      els.groupError.hidden = false;
      els.groupNameInput.focus();
      return;
    }
    // 同名分组在列表、移动菜单里无法区分，所以新建与重命名都要挡（重命名时排除自己）
    const clash = groups.find(group => group.id !== groupEditingId && groupNameKey(group.name) === groupNameKey(name));
    if (clash) {
      els.groupError.textContent = `已经有同名分组「${clash.name}」了，换一个名字`;
      els.groupError.hidden = false;
      els.groupNameInput.focus();
      els.groupNameInput.select();
      return;
    }
    if (groupDialogMode === 'rename') {
      const group = findGroup(groupEditingId);
      if (!group) {
        els.groupDialog.close();
        return;
      }
      group.name = name;
    } else {
      const group = { id: uid(), name, createdAt: new Date().toISOString() };
      groups.push(group);
      if (groupPendingMoveId) {
        const todo = findTodo(groupPendingMoveId);
        if (todo) {
          todo.groupId = group.id;
          todo.updatedAt = new Date().toISOString();
        }
      } else if (groupPendingCreate) {
        createTodo(groupPendingCreate.title, groupPendingCreate.date, group.id);
        els.quickInput.value = '';
      } else {
        standaloneGroup = group;
      }
    }
    groupPendingMoveId = null;
    groupPendingCreate = null;
    save();
    els.groupDialog.close();
    renderAll();
    if (standaloneGroup) openNoticeDialog(`已创建分组「${standaloneGroup.name}」。它还没有安排待办，添加待办时选择它，就会出现在当天`);
  }

  // 删除分组：分组与组内所有待办整体移入回收站——分组进「分组回收」，待办逐条进「待办回收」。
  // 进回收站的待办一律按未分组处理（groupId 置空）：之后单独恢复它就直接回到未分组区域；
  // 分组只保留 memberIds 作为批次记录，供彻底删除时连带清除，不再与这些待办有归属关系。
  function deleteGroup(id) {
    const index = groups.findIndex(group => group.id === id);
    if (index < 0) return;
    const [group] = groups.splice(index, 1);
    const now = new Date().toISOString();
    const members = todos.filter(todo => todo.groupId === id);
    if (members.length) {
      const memberIds = new Set(members.map(todo => todo.id));
      todos = todos.filter(todo => !memberIds.has(todo.id));
      members.forEach(todo => {
        todo.deletedAt = now;
        todo.updatedAt = now;
        todo.groupId = null;
        expanded.delete(todo.id);
      });
      // 保持组内原有先后顺序，整批放到回收站最前
      trashTodos.unshift(...members);
    }
    // 批次记录：回收站里属于这个分组的待办 id，彻底删除分组时据此一并清除
    group.memberIds = members.map(todo => todo.id);
    group.deletedAt = now;
    trashGroups.unshift(group);
    save();
    closeMenu();
    // 单日视图里若这一组是当天最后的内容，空态提示在塌缩收尾处接一段上浮淡入
    if (mode === 'day' && !tasksForDate(selectedDate).length) dayEmptyEnterPending = true;
    // 数据已在点击时更新：侧栏回收站计数（分组 + 这批待办）与单日汇总先跟上，
    // 不跟着面板塌缩动画一起滞后
    renderSidebar(todayKey());
    if (mode === 'day') updateDaySummary(todayKey());
    // 分组整块塌缩离场（与待办卡、回收站条目同一套节奏），播完再重渲染；
    // 待办已随分组进回收站，重渲染时整块消失，「未分组」不会接收这批待办
    animateExit($(`.group-block[data-group-id="${id}"]`), renderAll);
  }

  function openMoveDialog(todoId) {
    const todo = findTodo(todoId);
    if (!todo) return;
    pickContext = null;
    moveTodoId = todoId;
    closeMenu();
    els.moveTitle.textContent = '移动分组';
    const current = todo.groupId || null;
    const items = [{ id: null, name: '未分组' }].concat(groups.map(group => ({ id: group.id, name: group.name })));
    els.moveList.innerHTML = items.map(item => `<button class="move-item ${current === item.id ? 'is-current' : ''}" type="button" data-move-to="${item.id || ''}">
        <span class="move-name">${escape(item.name)}</span>
        ${current === item.id ? '<svg class="icon"><use href="#i-check"></use></svg>' : ''}
      </button>`).join('');
    els.moveDialog.showModal();
  }

  // 把一个待办挪到别的日期；groupId 原样保留，分组会跟着这一天一起出现在新日期里
  function openDayDialog(todoId) {
    const todo = findTodo(todoId);
    if (!todo) return;
    closeMenu();
    moveDayTodoId = todoId;
    moveDayCursor = dateKey(startOfMonth(parseKey(todo.date)));
    renderDayCal();
    els.dayDialog.showModal();
    els.dayCal.focus();
  }

  function shiftDayMonth(delta) {
    if (!moveDayCursor) return;
    const base = parseKey(moveDayCursor);
    moveDayCursor = dateKey(new Date(base.getFullYear(), base.getMonth() + delta, 1));
  }

  function renderDayCal() {
    const todo = findTodo(moveDayTodoId);
    if (!todo) return;
    const cursor = parseKey(moveDayCursor || dateKey(startOfMonth(parseKey(todo.date))));
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const offset = (new Date(year, month, 1).getDay() + 6) % 7;
    const total = new Date(year, month + 1, 0).getDate();
    let cells = '';
    for (let i = 0; i < offset; i += 1) cells += '<span class="pk-blank" aria-hidden="true"></span>';
    for (let day = 1; day <= total; day += 1) {
      const key = `${year}-${pad(month + 1)}-${pad(day)}`;
      const current = key === todo.date;
      const label = `${year} 年 ${month + 1} 月 ${day} 日`;
      cells += `<button class="pk-day ${current ? 'is-selected' : ''}" type="button" data-move-day="${key}" aria-label="${label}"${current ? ' aria-current="date"' : ''}>${day}</button>`;
    }
    // 与统计周期弹层一致：永远渲染 6 周（42 格），弹窗高度不随月份增减
    for (let i = offset + total; i < 42; i += 1) cells += '<span class="pk-blank" aria-hidden="true"></span>';
    els.dayCal.innerHTML = `<div class="pk-nav">
        <button class="pk-arrow" type="button" data-day-nav="-1" aria-label="上个月"><svg class="icon"><use href="#i-chevron-left"></use></svg></button>
        <span class="pk-month">${year}年${month + 1}月</span>
        <button class="pk-arrow" type="button" data-day-nav="1" aria-label="下个月"><svg class="icon"><use href="#i-chevron-right"></use></svg></button>
      </div>
      <div class="pk-weekdays" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
      <div class="pk-grid">${cells}</div>`;
    const group = todo.groupId ? findGroup(todo.groupId) : null;
    els.dayCalNote.textContent = group ? `当前在「${group.name}」分组，移动后分组保持不变` : '';
  }

  function moveTodoToDate(id, key) {
    const todo = findTodo(id);
    if (!todo) return;
    els.dayDialog.close();
    if (todo.date === key) return;
    todo.date = key;
    todo.updatedAt = new Date().toISOString();
    save();
    renderAll();
  }

  /* ---------------- 克隆待办 ---------------- */

  const CLONE_PATTERNS = [
    { key: 'daily', label: '克隆至后续每一天', hint: '包含工作日和休息日' },
    { key: 'weekdays', label: '克隆至后续工作日', hint: '周一至周五' },
    { key: 'weekends', label: '克隆至后续休息日', hint: '周六、周日' }
  ];

  function openCloneDialog(todoId) {
    const todo = findTodo(todoId);
    if (!todo) return;
    closeMenu();
    cloneContext = {
      todoId,
      pattern: 'range',
      start: null,
      end: null,
      field: 'start',
      cursor: dateKey(startOfMonth(parseKey(addDays(todo.date, 1)))),
      advancedOpen: false,
      error: ''
    };
    renderClonePicker();
    els.cloneDialog.showModal();
    els.clonePicker.focus();
  }

  function cloneTargetDates(context = cloneContext) {
    if (!context || !validKey(context.start) || !validKey(context.end) || context.end < context.start) return [];
    const todo = findTodo(context.todoId);
    if (!todo || context.start <= todo.date) return [];
    const dates = [];
    // 不使用统计周期的 31 天限制；跨月、跨年也按本地日历逐日计算。
    for (let key = context.start; validKey(key) && key <= context.end; key = addDays(key, 1)) {
      const weekday = parseKey(key).getDay();
      const weekend = weekday === 0 || weekday === 6;
      if (context.pattern === 'weekdays' && weekend) continue;
      if (context.pattern === 'weekends' && !weekend) continue;
      dates.push(key);
    }
    return dates;
  }

  // 同月保留日期按钮，只更新文字和选中状态，让填充色的过渡能完整播放。
  // 翻月时仅替换日期网格，避免把上个月某一格的选中色带到新月份。
  function updateClonePicker(markup) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    const patch = (current, next) => {
      if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName ||
          (current.nodeType === Node.ELEMENT_NODE && current.hasAttribute('data-picker-month') &&
           current.dataset.pickerMonth !== next.dataset.pickerMonth)) {
        current.replaceWith(next);
        return;
      }
      if (current.nodeType !== Node.ELEMENT_NODE) {
        if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
        return;
      }
      for (const attribute of [...current.attributes]) {
        if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
      }
      for (const attribute of next.attributes) {
        if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
      }
      patchChildren(current, next);
    };
    const patchChildren = (current, next) => {
      const children = [...current.childNodes];
      const nextChildren = [...next.childNodes];
      children.forEach((child, index) => {
        if (nextChildren[index]) patch(child, nextChildren[index]);
        else child.remove();
      });
      nextChildren.slice(children.length).forEach(child => current.append(child));
    };
    patchChildren(els.clonePicker, template.content);
  }

  function renderClonePicker(focusSelector) {
    if (!cloneContext) return;
    const todo = findTodo(cloneContext.todoId);
    if (!todo) {
      els.cloneDialog.close();
      openNoticeDialog('原待办已不存在，请关闭后重新选择。', '无法克隆');
      return;
    }
    const context = cloneContext;
    const advanced = context.pattern !== 'range';
    const pattern = CLONE_PATTERNS.find(item => item.key === context.pattern);
    const dates = cloneTargetDates();
    const errorMessage = context.error || (context.end && !dates.length ? '当前范围没有符合条件的日期，请重新选择。' : '');
    const targets = new Set(dates);
    const selected = context.field === 'start' ? context.start : context.end;
    const isDateDisabled = key => key <= todo.date || Boolean((advanced || context.field === 'end') && context.start && key < context.start);
    const calendar = pickerMonthInner(parseKey(context.cursor), 'clone', key => ({
      selected: key === selected,
      inRange: targets.has(key),
      edge: targets.has(key) && (key === context.start || key === context.end),
      disabled: isDateDisabled(key)
    }));
    const dateField = (field, label, value) => `<div class="range-field">
        <span class="range-field-label">${label}</span>
        <button class="date-field clone-date-field ${context.field === field ? 'is-active' : ''}" type="button" data-clone-field="${field}" aria-label="选择克隆${label}"${advanced && field === 'start' ? ' disabled' : ''}>
          <span class="date-text">${value ? formatSlash(value) : '请选择'}</span>
          <svg class="icon"><use href="#i-calendar"></use></svg>
        </button>
      </div>`;
    updateClonePicker(`<div class="pk-head">
        <p class="pk-caption" id="clone-title">选择${context.field === 'start' ? '开始' : '结束'}日期</p>
      </div>
      <p class="clone-source" id="clone-source" title="${escape(todo.title)}">克隆「${escape(todo.title)}」</p>
      <div class="range-fields clone-fields">
        ${dateField('start', '开始日期', context.start)}
        <span class="range-dash" aria-hidden="true">—</span>
        ${dateField('end', '结束日期', context.end)}
      </div>
      ${calendar}
      <div class="pk-foot">
        <div class="clone-advanced">
          <button class="clone-button clone-advanced-trigger" type="button" data-clone-action="advanced" aria-haspopup="menu" aria-expanded="${context.advancedOpen}" aria-controls="clone-options">高级选项<svg class="icon"><use href="#i-chevron-right"></use></svg></button>
          <div class="clone-options" id="clone-options" role="menu" aria-label="克隆规则"${context.advancedOpen ? '' : ' hidden'}>
            ${CLONE_PATTERNS.map(item => `<button type="button" role="menuitemradio" aria-checked="${context.pattern === item.key}" data-clone-pattern="${item.key}">${item.label}<small>${item.hint}</small></button>`).join('')}
          </div>
        </div>
        <p class="clone-rule"${advanced ? '' : ' hidden'}>${pattern ? pattern.label : ''}</p>
      </div>
      <p class="clone-error" role="alert"${errorMessage ? '' : ' hidden'}>${escape(errorMessage)}</p>
      <div class="clone-actions">
        <button class="clone-button" type="button" data-clone-action="cancel">取消</button>
        <button class="clone-button is-primary" type="button" data-clone-action="submit"${dates.length ? '' : ' disabled'}>${dates.length ? `克隆 ${dates.length} 项` : '确认克隆'}</button>
      </div>`);
    if (focusSelector) {
      const focusTarget = $(focusSelector, els.clonePicker);
      if (focusTarget) focusTarget.focus({ preventScroll: true });
    }
  }

  function selectCloneDay(key) {
    if (!cloneContext || !validKey(key)) return;
    const todo = findTodo(cloneContext.todoId);
    if (!todo || key <= todo.date) return;
    const context = cloneContext;
    if (context.pattern !== 'range' || context.field === 'end') {
      if (context.start && key < context.start) return;
      if (!context.start) context.start = key;
      context.end = key;
    } else {
      context.start = key;
      context.end = key;
      context.field = 'end';
    }
    context.advancedOpen = false;
    context.error = '';
    renderClonePicker(`[data-clone-day="${key}"]`);
  }

  function selectClonePattern(pattern) {
    if (!cloneContext || !CLONE_PATTERNS.some(item => item.key === pattern)) return;
    const todo = findTodo(cloneContext.todoId);
    if (!todo) return;
    cloneContext.pattern = pattern;
    cloneContext.start = addDays(todo.date, 1);
    cloneContext.end = null;
    cloneContext.field = 'end';
    cloneContext.cursor = dateKey(startOfMonth(parseKey(cloneContext.start)));
    cloneContext.advancedOpen = false;
    cloneContext.error = '';
    renderClonePicker();
    els.clonePicker.focus();
  }

  function submitClone() {
    if (!cloneContext) return;
    const source = findTodo(cloneContext.todoId);
    const dates = cloneTargetDates();
    if (!source || !dates.length) {
      renderClonePicker();
      return;
    }
    const now = new Date().toISOString();
    const previousLength = todos.length;
    dates.forEach(date => {
      todos.push({
        id: uid(),
        date,
        title: source.title,
        done: false,
        highlighted: source.highlighted,
        groupId: source.groupId && groups.some(group => group.id === source.groupId) ? source.groupId : null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        deletedAt: null,
        notes: source.notes.map(note => ({ id: uid(), text: note.text, createdAt: now }))
      });
    });
    // 整批只保存一次；存储失败则撤回新增数据，保留所选日期供用户重试。
    if (!save()) {
      todos.splice(previousLength);
      cloneContext.error = '保存失败，未新增待办。请释放浏览器存储空间后重试。';
      renderClonePicker('[data-clone-action="submit"]');
      return;
    }
    els.cloneDialog.close();
    renderAll();
    const destination = dates.length === 1 ? formatSlash(dates[0]) : `${formatSlash(dates[0])} 至 ${formatSlash(dates[dates.length - 1])}`;
    openNoticeDialog(`已克隆 ${dates.length} 项待办到 ${destination}，新待办均为未完成。`, '克隆完成');
  }

  // 新建待办时若已有分组，先用同一个弹窗问一句要放进哪个分组
  function openPickGroupDialog(title, date) {
    moveTodoId = null;
    pickContext = { title, date };
    closeMenu();
    els.moveTitle.textContent = '加入哪个分组？';
    const items = [{ id: null, name: '不加入分组' }].concat(groups.map(group => ({ id: group.id, name: group.name })));
    els.moveList.innerHTML = items.map(item => `<button class="move-item" type="button" data-move-to="${item.id || ''}">
        <span class="move-name">${escape(item.name)}</span>
      </button>`).join('');
    els.moveDialog.showModal();
  }

  function createFromPick(groupId) {
    const context = pickContext;
    pickContext = null;
    if (els.moveDialog.open) els.moveDialog.close();
    if (!context) return;
    createTodo(context.title, context.date, groupId);
    els.quickInput.value = '';
    renderAll();
    els.quickInput.focus();
  }

  function moveTodo(id, groupId) {
    const todo = findTodo(id);
    if (!todo) return;
    todo.groupId = groupId && groups.some(group => group.id === groupId) ? groupId : null;
    todo.updatedAt = new Date().toISOString();
    save();
    moveTodoId = null;
    els.moveDialog.close();
    renderAll();
  }

  /* ---------------- 回收站 ---------------- */

  // 恢复待办：回到原日期；原分组已不存在时以未分组身份回来。
  // 条目先做上浮离场动画再重渲染，不做文字提示
  function restoreTodo(id) {
    const index = trashTodos.findIndex(todo => todo.id === id);
    if (index < 0) return;
    const [todo] = trashTodos.splice(index, 1);
    todo.deletedAt = null;
    if (todo.groupId && !groups.some(group => group.id === todo.groupId)) todo.groupId = null;
    todo.updatedAt = new Date().toISOString();
    if (todos.some(item => item.id === todo.id)) todo.id = uid();
    todos.push(todo);
    save();
    animateTrashItemsLeaving([$(`.trash-item[data-trash-id="${id}"]`)], 'restore');
  }

  // 恢复分组：只把分组本身放回清单——空的骨架，不还原删除前组内的待办。
  // 那批待办留在「待办回收」里，需要时逐条恢复，恢复后按未分组处理（两条路径互不影响）。
  function restoreGroup(id) {
    const index = trashGroups.findIndex(group => group.id === id);
    if (index < 0) return;
    const [group] = trashGroups.splice(index, 1);
    const memberIds = new Set(Array.isArray(group.memberIds) ? group.memberIds : []);
    // 同批进回收站的待办与分组彻底脱钩：即使之后才恢复它们，也回到未分组而不是本组
    trashTodos.forEach(todo => {
      if (memberIds.has(todo.id)) todo.groupId = null;
    });
    group.deletedAt = null;
    group.memberIds = [];
    if (groups.some(item => item.id === group.id)) group.id = uid();
    // 已有同名分组时自动加序号，恢复后不会出现两个分不清的同名分组
    group.name = uniqueGroupName(group.name);
    groups.push(group);
    save();
    animateTrashItemsLeaving([$(`.trash-item[data-trash-id="${id}"]`)], 'restore');
  }

  // 彻底删除：确认后条目塌缩离场（与待办卡删除同款），动画播完才重渲染
  function purgeTodo(id) {
    const index = trashTodos.findIndex(todo => todo.id === id);
    if (index < 0) return;
    const todo = trashTodos[index];
    if (!window.confirm(`彻底删除「${todo.title}」后无法恢复，确定删除吗？`)) return;
    trashTodos.splice(index, 1);
    save();
    animateTrashItemsLeaving([$(`.trash-item[data-trash-id="${id}"]`)]);
  }

  // 彻底删除分组：随分组一起进回收站的待办也一并清除，两者同批塌缩离场
  function purgeGroup(id) {
    const index = trashGroups.findIndex(group => group.id === id);
    if (index < 0) return;
    const group = trashGroups[index];
    const memberIds = new Set(Array.isArray(group.memberIds) ? group.memberIds : []);
    const ownTodos = trashTodos.filter(todo => todo.groupId === group.id || memberIds.has(todo.id));
    const suffix = ownTodos.length ? `及其 ${ownTodos.length} 项待办` : '';
    if (!window.confirm(`彻底删除分组「${group.name}」${suffix}后无法恢复，确定删除吗？`)) return;
    trashGroups.splice(index, 1);
    if (ownTodos.length) {
      const ids = new Set(ownTodos.map(todo => todo.id));
      trashTodos = trashTodos.filter(todo => !ids.has(todo.id));
    }
    save();
    animateTrashItemsLeaving([
      $(`.trash-item[data-trash-id="${id}"]`),
      ...ownTodos.map(todo => $(`.trash-item[data-trash-id="${todo.id}"]`))
    ]);
  }

  // 清空分区：数据先行更新，同区条目一起塌缩离场，全部播完后再统一重渲染。
  // 清空「分组回收」时，随这些分组一起进来的待办也一并清除（与彻底删除分组同一规则）
  function clearTrash(kind) {
    let leaving = [];
    if (kind === 'groups') {
      if (!trashGroups.length) return;
      const groupIds = new Set(trashGroups.map(group => group.id));
      const memberIds = new Set(trashGroups.reduce((all, group) => all.concat(group.memberIds || []), []));
      const ownTodos = trashTodos.filter(todo => groupIds.has(todo.groupId) || memberIds.has(todo.id));
      const suffix = ownTodos.length ? `（连同其下 ${ownTodos.length} 项待办）` : '';
      if (!window.confirm(`将彻底删除回收站里的 ${trashGroups.length} 个分组${suffix}，无法恢复，继续吗？`)) return;
      trashGroups = [];
      if (ownTodos.length) {
        const ids = new Set(ownTodos.map(todo => todo.id));
        trashTodos = trashTodos.filter(todo => !ids.has(todo.id));
      }
      leaving = $$('.trash-item[data-trash-kind="group"]', els.trashContent)
        .concat(ownTodos.map(todo => $(`.trash-item[data-trash-id="${todo.id}"]`)));
    } else {
      if (!trashTodos.length) return;
      if (!window.confirm(`将彻底删除回收站里的 ${trashTodos.length} 项待办，无法恢复，继续吗？`)) return;
      trashTodos = [];
      leaving = $$('.trash-item[data-trash-kind="todo"]', els.trashContent);
    }
    save();
    animateTrashItemsLeaving(leaving);
  }

  function trashTodoRow(todo) {
    return `<article class="trash-item" data-trash-id="${todo.id}" data-trash-kind="todo">
      <div class="trash-main">
        <p class="trash-item-title">${escape(todo.title)}</p>
        <p class="trash-item-meta">
          <span>删除于 ${escape(formatTime(todo.deletedAt))}</span>
        </p>
      </div>
      <div class="trash-actions">
        <button class="quick-btn" type="button" data-action="trash-restore" title="恢复到 ${escape(formatShort(todo.date))}"><svg class="icon"><use href="#i-restore"></use></svg>恢复</button>
        <button class="tool-btn danger" type="button" data-action="trash-purge" title="彻底删除" aria-label="彻底删除「${escape(todo.title)}」"><svg class="icon"><use href="#i-trash"></use></svg></button>
      </div>
    </article>`;
  }

  function trashGroupRow(group) {
    return `<article class="trash-item" data-trash-id="${group.id}" data-trash-kind="group">
      <div class="trash-main">
        <p class="trash-item-title">${escape(group.name)}</p>
        <p class="trash-item-meta">
          <span>删除于 ${escape(formatTime(group.deletedAt))}</span>
        </p>
      </div>
      <div class="trash-actions">
        <button class="quick-btn" type="button" data-action="trash-restore" title="恢复该分组"><svg class="icon"><use href="#i-restore"></use></svg>恢复</button>
        <button class="tool-btn danger" type="button" data-action="trash-purge" title="彻底删除" aria-label="彻底删除分组「${escape(group.name)}」"><svg class="icon"><use href="#i-trash"></use></svg></button>
      </div>
    </article>`;
  }

  // 回收站页面：待办回收与分组回收两个分区，结构沿用分组面板。
  // 分区为空时只留标题行——没有占位文案，也没有空态提示的入场动画
  function renderTrash() {
    const panelSelector = '.trash-sections > .trash-panel';
    const panelKey = panel => panel.getAttribute('aria-label');
    const prevHeights = capturePanelHeights(els.trashContent, panelSelector, panelKey);

    const todoSection = `<section class="trash-panel${trashTodos.length ? '' : ' is-empty'}" aria-label="待办回收">
      <header class="trash-head">
        <h2 class="panel-title">待办 <small>${trashTodos.length} 项</small></h2>
        ${trashTodos.length ? '<button class="ghost-btn trash-clear" type="button" data-action="trash-clear-todos">清空</button>' : ''}
      </header>
      ${trashTodos.length ? `<div class="trash-list">${trashTodos.map(trashTodoRow).join('')}</div>` : ''}
    </section>`;
    const groupSection = `<section class="trash-panel${trashGroups.length ? '' : ' is-empty'}" aria-label="分组回收">
      <header class="trash-head">
        <h2 class="panel-title">分组 <small>${trashGroups.length} 个</small></h2>
        ${trashGroups.length ? '<button class="ghost-btn trash-clear" type="button" data-action="trash-clear-groups">清空</button>' : ''}
      </header>
      ${trashGroups.length ? `<div class="trash-list">${trashGroups.map(trashGroupRow).join('')}</div>` : ''}
    </section>`;
    els.trashContent.innerHTML = `<div class="trash-sections">${todoSection}${groupSection}</div>`;
    animatePanelShrink(els.trashContent, panelSelector, panelKey, prevHeights);
  }

  function openDrawer() {
    document.body.classList.add('nav-open');
    clearTimeout(scrimTimer);
    els.scrim.hidden = false;
    requestAnimationFrame(() => {
      if (document.body.classList.contains('nav-open')) els.scrim.classList.add('is-show');
    });
    els.menuBtn.setAttribute('aria-expanded', 'true');
  }

  function closeDrawer() {
    document.body.classList.remove('nav-open');
    els.scrim.classList.remove('is-show');
    clearTimeout(scrimTimer);
    scrimTimer = setTimeout(() => { els.scrim.hidden = true; }, 260);
    els.menuBtn.setAttribute('aria-expanded', 'false');
  }

  function exportData() {
    const payload = {
      app: 'daylist',
      version: 3,
      exportedAt: new Date().toISOString(),
      todos,
      groups,
      trash: { todos: trashTodos, groups: trashGroups }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `待办备份-${todayKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importData(file) {
    try {
      // 备份文件正常只有几 KB，超大文件多半是选错了文件，直接拒绝避免卡死页面
      if (file.size > 10 * 1024 * 1024) throw new Error('file too large');
      const text = await file.text();
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.todos) ? data.todos : null);
      if (!list) throw new Error('bad file');
      const clean = dedupeTodos(list);
      if (!clean.length) throw new Error('empty file');
      const confirmed = window.confirm(`将用导入的 ${clean.length} 条待办替换当前 ${todos.length} 条记录，继续吗？`);
      if (!confirmed) return;
      groups = Array.isArray(data.groups) ? dedupeGroups(data.groups) : [];
      todos = clean;
      const rawTrash = !Array.isArray(data) && data && data.trash && typeof data.trash === 'object' ? data.trash : {};
      trashTodos = Array.isArray(rawTrash.todos) ? dedupeTodos(rawTrash.todos) : [];
      trashGroups = Array.isArray(rawTrash.groups) ? dedupeGroups(rawTrash.groups) : [];
      normalizeGroups();
      expanded.clear();
      overdueOpen = false;
      menuOpen = null;
      save();
      renderAll();
    } catch (error) {
      console.warn('导入失败：请选择本应用导出的 JSON 文件', error);
      // 只写 console 用户完全感知不到，导入失败要给出可见反馈
      window.alert('导入失败：请选择本应用「导出」生成的 JSON 备份文件（10MB 以内）。');
    } finally {
      els.importFile.value = '';
    }
  }

  function checkDayChange() {
    const current = todayKey();
    if (current === lastKnownDay) return;
    const wasToday = mode === 'day' && selectedDate === lastKnownDay;
    lastKnownDay = current;
    // 跨天之后回到默认收起状态，重新出现超期时也从收起开始
    overdueOpen = false;
    expanded.clear();
    if (wasToday) {
      selectedDate = current;
      calendarCursor = startOfMonth(parseKey(current));
    }
    renderAll();
  }

  function isTyping() {
    const element = document.activeElement;
    return Boolean(element && (element.matches('input, textarea, select') || element.isContentEditable));
  }

  /* ---------------- Events ---------------- */

  els.calGrid.addEventListener('click', event => {
    const button = event.target.closest('.cal-day');
    if (button) goDay(button.dataset.date);
  });

  els.calPrev.addEventListener('click', () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
    renderCalendar(todayKey());
    renderMonthSummary();
  });

  els.calNext.addEventListener('click', () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
    renderCalendar(todayKey());
    renderMonthSummary();
  });

  els.calTitle.addEventListener('click', () => {
    calendarCursor = startOfMonth(new Date());
    renderCalendar(todayKey());
    renderMonthSummary();
  });

  els.navOverview.addEventListener('click', goOverview);
  els.navToday.addEventListener('click', () => goDay(todayKey()));
  els.navGroups.addEventListener('click', goGroups);
  els.navTrash.addEventListener('click', goTrash);
  $('#brand-link').addEventListener('click', event => {
    event.preventDefault();
    goOverview();
  });

  els.weekStrip.addEventListener('click', event => {
    const button = event.target.closest('[data-date]');
    if (button) goDay(button.dataset.date);
  });

  els.todayBtn.addEventListener('click', () => goDay(todayKey()));

  els.fabNew.addEventListener('click', () => openCreate(mode === 'day' ? selectedDate : todayKey()));
  els.groupAdd.addEventListener('click', () => openGroupDialog({ mode: 'create' }));
  els.groupViewAdd.addEventListener('click', () => openGroupDialog({ mode: 'create' }));

  els.quickAddBtn.addEventListener('click', () => {
    const title = els.quickInput.value.trim();
    if (!title) {
      els.quickInput.focus();
      return;
    }
    // 有分组时先问加入哪个分组；没有分组就直接建在未分组里
    if (groups.length) {
      openPickGroupDialog(title.slice(0, 200), selectedDate);
      return;
    }
    createTodo(title.slice(0, 200), selectedDate);
    els.quickInput.value = '';
    renderAll();
    els.quickInput.focus();
  });

  els.overviewContent.addEventListener('click', event => {
    const card = event.target.closest('[data-todo-id]');
    if (card) {
      openTodo(card.dataset.todoId, card.dataset.noteId || null);
      return;
    }
    const preset = event.target.closest('[data-range-preset]');
    if (preset) {
      rangePreset(preset.dataset.rangePreset);
      renderOverview(todayKey());
      return;
    }
    const openCal = event.target.closest('[data-open-cal]');
    if (openCal) {
      openCalendar(openCal.dataset.openCal);
      renderRangePop();
      return;
    }
    const calNav = event.target.closest('[data-cal-nav]');
    if (calNav) {
      shiftCalMonth(Number(calNav.dataset.calNav));
      renderRangePop();
      return;
    }
    const calDay = event.target.closest('[data-cal-day]');
    if (calDay) {
      const day = calDay.dataset.calDay;
      if (calField === 'end') applyRange(rangeStart, day, 'end');
      else applyRange(day, rangeEnd, 'start');
      calField = null;
      renderOverview(todayKey());
      return;
    }
    const calAction = event.target.closest('[data-cal-action]');
    if (calAction) {
      const kind = calAction.dataset.calAction;
      if (kind === 'back') {
        calField = null;
        renderRangePop();
      } else if (kind === 'today') {
        const now = todayKey();
        if (calField === 'end') applyRange(rangeStart, now, 'end');
        else applyRange(now, rangeEnd, 'start');
        calField = null;
        renderOverview(now);
      } else if (kind === 'clear') {
        const base = defaultRange();
        applyRange(base.start, base.end, 'start');
        calField = null;
        renderOverview(todayKey());
      }
      return;
    }
    const dayButton = event.target.closest('[data-date]');
    if (dayButton) {
      goDay(dayButton.dataset.date);
      return;
    }
    const action = event.target.closest('[data-action]');
    if (!action) return;
    const name = action.dataset.action;
    if (name === 'toggle-range') {
      rangeOpen = !rangeOpen;
      calField = null;
      renderOverview(todayKey());
    } else if (name === 'close-range') {
      rangeOpen = false;
      calField = null;
      renderOverview(todayKey());
    } else if (name === 'new') {
      openCreate(todayKey());
    } else if (name === 'today') {
      goDay(todayKey());
    }
  });

  function handleTaskClick(event) {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) {
      // 本次点击先让打开中的菜单只做关闭（与常见 UI 一致：菜单拦截第一次空白点击）。
      // 菜单是否开着以捕获层标记为准：menuOpen 在捕获阶段可能已被清空
      const hadMenu = menuClosedOnCapture;
      menuClosedOnCapture = false;
      closeMenu();
      // 单击待办条内非功能区域 → 展开/收起备注详情（再点一次即还原收起）。
      // 「点在文字上」以逐行文字矩形实时判定（与双击命中区域同一套计算）：
      // 点在任一行文字上不触发任何操作（双击才进入重命名）；
      // 没落在任何行文字上的区域——包括第二行比第一行短出来的行尾空白——
      // 视为待办条空白，正常参与展开/收起；
      // 取不到文字矩形时保守按文字处理。输入框等表单控件与下拉菜单内部
      // 点击不参与收合——输入备注时面板不会被误收
      const target = event.target;
      let skipToggle = false;
      const titleEl = target.closest('.task-title');
      if (titleEl) {
        const rows = getTitleTextRects(titleEl);
        skipToggle = !rows || pointInTextRows(rows, event.clientX, event.clientY);
      }
      if (!hadMenu && !skipToggle
        && !target.closest('.task-menu')
        && !target.closest('button, a, textarea, input, select')) {
        const card = target.closest('.task');
        if (card && card.dataset.id) toggleExpand(card.dataset.id);
      }
      return;
    }
    const action = actionEl.dataset.action;
    if (action === 'new-group') {
      openGroupDialog({ mode: 'create' });
      return;
    }
    if (action === 'group-edit') {
      openGroupDialog({ mode: 'rename', groupId: actionEl.dataset.groupId });
      return;
    }
    if (action === 'group-menu') {
      toggleGroupMenu(actionEl.dataset.groupId, actionEl);
      return;
    }
    if (action === 'group-rename') {
      openGroupDialog({ mode: 'rename', groupId: actionEl.dataset.groupId });
      return;
    }
    if (action === 'group-delete') {
      deleteGroup(actionEl.dataset.groupId);
      return;
    }
    if (action === 'overdue-toggle') {
      // 眼睛按钮原地展开/收拢：列表高度过渡动画，图标与 aria 状态同步更新
      toggleOverdueBlock();
      return;
    }
    const taskEl = actionEl.closest('.task');
    if (!taskEl) return;
    const id = taskEl.dataset.id;
    if (action === 'toggle') toggleDone(id);
    else if (action === 'expand') toggleExpand(id);
    else if (action === 'highlight') toggleHighlight(id);
    else if (action === 'menu') toggleMenu(id);
    else if (action === 'clone') openCloneDialog(id);
    else if (action === 'edit') openEdit(id);
    else if (action === 'move') openMoveDialog(id);
    else if (action === 'move-day') openDayDialog(id);
    else if (action === 'delete') deleteTodo(id);
    else if (action === 'note-delete') {
      const noteEl = actionEl.closest('.note');
      if (noteEl) deleteNote(id, noteEl.dataset.noteId);
    }
  }

  els.taskList.addEventListener('click', handleTaskClick);
  els.overdueBlock.addEventListener('click', handleTaskClick);
  els.groupsContent.addEventListener('click', handleTaskClick);

  // 双击待办条文字 → 进入重命名（复用「修改待办」弹窗，打开即全选标题）。
  // 文字单击无任何操作，双击前不会误触发展开；双击其他区域（空白/按钮）不进入重命名。
  // 命中区域实时计算（见 getTitleTextRects）：不缓存、不用固定区域，布局变化后即按当下布局判定

  // 取待办文字的实际渲染矩形（每个文字行一个矩形）：用 Range 按行取。
  // .task-title 元素盒子在多行或被压缩时会大于文字本身（铺满可用宽度），
  // 直接用元素盒子会让「文字右侧空白」也命中，所以必须以文字行为基准。
  // 只统计 .mark（标题文字本体）的行矩形——「有备注」提示不算待办文字；
  // 每次点击/双击时调用，文字内容、字体、容器宽度或布局变化后自然按最新布局重新计算
  function getTitleTextRects(titleEl) {
    const textNode = $('.mark', titleEl) || titleEl;
    try {
      const range = document.createRange();
      range.selectNodeContents(textNode);
      return Array.from(range.getClientRects()).filter(rect => rect.width > 0 || rect.height > 0);
    } catch (error) {
      return null;
    }
  }

  // 点是否落在某一行文字矩形内（逐行判定）：命中即视为「点在文字上」。
  // 没有文字渲染的区域（如第二行比第一行短出来的行尾空白）不算文字：
  // 单击按待办条空白处理、可展开/收起详情，双击也不触发重命名
  const pointInTextRows = (rows, x, y) => rows.some(row =>
    x >= row.left && x <= row.right && y >= row.top && y <= row.bottom);

  function handleTaskDblClick(event) {
    const titleEl = event.target.closest('.task-title');
    if (!titleEl) return;
    const card = titleEl.closest('.task');
    if (!card || !card.dataset.id) return;
    // 双击必须落在某一行文字的实际渲染矩形内才触发弹窗：
    // 没有文字渲染的区域（元素盒子空白、换行后行尾空白等）一律不进入重命名；
    // 取不到文字矩形（极端布局）时退回元素盒子判定
    const rows = getTitleTextRects(titleEl);
    if (rows && !pointInTextRows(rows, event.clientX, event.clientY)) return;
    event.preventDefault();
    // 双击默认会选中一个词：打开弹窗前清掉，避免选区残留在背后
    if (window.getSelection) window.getSelection().removeAllRanges();
    openEdit(card.dataset.id, { selectAll: true });
  }
  els.taskList.addEventListener('dblclick', handleTaskDblClick);
  els.overdueBlock.addEventListener('dblclick', handleTaskDblClick);
  els.groupsContent.addEventListener('dblclick', handleTaskDblClick);

  // 回收站页：恢复 / 彻底删除 / 分区清空
  els.trashContent.addEventListener('click', event => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'trash-clear-todos') {
      clearTrash('todos');
      return;
    }
    if (action === 'trash-clear-groups') {
      clearTrash('groups');
      return;
    }
    const itemEl = actionEl.closest('.trash-item');
    if (!itemEl) return;
    const id = itemEl.dataset.trashId;
    if (action === 'trash-restore') {
      if (itemEl.dataset.trashKind === 'group') restoreGroup(id);
      else restoreTodo(id);
    } else if (action === 'trash-purge') {
      if (itemEl.dataset.trashKind === 'group') purgeGroup(id);
      else purgeTodo(id);
    }
  });

  function handleNoteSubmit(event) {
    const form = event.target.closest('.note-add');
    if (!form) return;
    event.preventDefault();
    const textarea = $('textarea', form);
    const text = textarea.value.trim();
    if (!text) {
      textarea.focus();
      return;
    }
    addNote(form.dataset.id, text);
  }

  els.taskList.addEventListener('submit', handleNoteSubmit);
  els.overdueBlock.addEventListener('submit', handleNoteSubmit);
  els.groupsContent.addEventListener('submit', handleNoteSubmit);

  [els.taskList, els.overdueBlock, els.groupsContent].forEach(container => {
    container.addEventListener('input', event => {
      if (event.target.matches('.note-add textarea')) autoGrow(event.target);
    });
  });

  // 捕获层关掉菜单时置位：冒泡层的空白点击据此跳过展开（本次点击只负责关菜单）。
  // 必须用标记传递——menuOpen 在捕获阶段已被清空，冒泡层读不到「点击前菜单开着」
  let menuClosedOnCapture = false;

  document.addEventListener('click', event => {
    if (!menuOpen && !groupMenuOpen) return;
    if (event.target.closest('.task-menu') || event.target.closest('[data-action="menu"]')) return;
    if (event.target.closest('.group-menu') || event.target.closest('[data-action="group-menu"]')) return;
    closeMenu();
    menuClosedOnCapture = true;
  });

  // 原地收起展开中的备注面板（可排除某张卡片）：与 toggleExpand 同一收起过渡，不重渲染列表
  function collapsePanels(exceptId) {
    let changed = false;
    for (const key of Array.from(expanded)) {
      if (key === exceptId) continue;
      expanded.delete(key);
      changed = true;
      const card = $(`.task[data-id="${key}"]`);
      if (!card) continue;
      const panel = $('.notes-panel', card);
      if (panel) setPanelOpen(panel, false);
      $$('[data-action="expand"]', card).forEach(btn => btn.setAttribute('aria-expanded', 'false'));
    }
    return changed;
  }

  // 备注详情的自动收起：点开某条待办的详情后，点到面板外的任何地方
  // （切换界面、点其他卡片或功能、页面空白处）就收起；面板内的输入与按钮不打断。
  // 例外：点击同一条待办自身的非控件区域（含主体空白）不在这里抢收，
  // 交给冒泡阶段的 toggleExpand 统一开合——否则捕获层先收起、冒泡层又展开，
  // 表现为「再点一次收不起来」。单击文案由此保持无操作。
  // 收起走原地过渡动画，不重渲染列表
  document.addEventListener('click', event => {
    if (!expanded.size) return;
    const expandTrigger = event.target.closest('[data-action="expand"]');
    if (expandTrigger) {
      const card = expandTrigger.closest('.task');
      if (!card) return;
      // 先收起其他卡片的面板（本卡片的展开状态由随后的 toggleExpand 统一处理）
      collapsePanels(card.dataset.id);
      return;
    }
    const panel = event.target.closest('.notes-panel');
    if (panel) {
      const card = panel.closest('.task');
      if (card && expanded.has(card.dataset.id)) return;
    }
    const task = event.target.closest('.task');
    if (task && expanded.has(task.dataset.id)
      && !event.target.closest('button, a, textarea, input, select')
      && !event.target.closest('.task-menu')) {
      return;
    }
    collapsePanels(null);
  }, true);

  // 点击统计周期弹层以外的区域时收起弹层
  document.addEventListener('click', event => {
    if (!rangeOpen) return;
    // 弹层内部重渲染后点击目标已脱离文档，当作内部点击处理，避免误关
    if (!event.target.isConnected) return;
    if (event.target.closest('.range-picker')) return;
    rangeOpen = false;
    calField = null;
    if (mode === 'overview') renderOverview(todayKey());
  });

  els.modalClose.addEventListener('click', closeDialog);
  els.modalCancel.addEventListener('click', closeDialog);
  els.dialog.addEventListener('click', event => {
    if (event.target === els.dialog) closeDialog();
  });
  els.form.addEventListener('submit', event => {
    event.preventDefault();
    saveDialog();
  });

  els.groupForm.addEventListener('submit', event => {
    event.preventDefault();
    saveGroup();
  });
  els.groupClose.addEventListener('click', () => els.groupDialog.close());
  els.groupCancel.addEventListener('click', () => els.groupDialog.close());
  els.groupDialog.addEventListener('click', event => {
    if (event.target === els.groupDialog) els.groupDialog.close();
  });
  els.groupDialog.addEventListener('close', () => {
    groupPendingMoveId = null;
    groupPendingCreate = null;
    groupEditingId = null;
    els.groupError.hidden = true;
  });

  els.moveClose.addEventListener('click', () => els.moveDialog.close());
  els.moveCancel.addEventListener('click', () => els.moveDialog.close());
  els.moveDialog.addEventListener('click', event => {
    if (event.target === els.moveDialog) els.moveDialog.close();
  });
  els.moveDialog.addEventListener('close', () => {
    moveTodoId = null;
    pickContext = null;
  });
  els.moveList.addEventListener('click', event => {
    const button = event.target.closest('[data-move-to]');
    if (!button) return;
    const groupId = button.dataset.moveTo || null;
    if (pickContext) {
      createFromPick(groupId);
      return;
    }
    if (!moveTodoId) return;
    moveTodo(moveTodoId, groupId);
  });
  els.dayClose.addEventListener('click', () => els.dayDialog.close());
  els.dayCancel.addEventListener('click', () => els.dayDialog.close());
  els.dayDialog.addEventListener('click', event => {
    if (event.target === els.dayDialog) els.dayDialog.close();
  });
  els.dayDialog.addEventListener('close', () => {
    moveDayTodoId = null;
    moveDayCursor = null;
  });
  els.dayDialog.addEventListener('click', event => {
    const nav = event.target.closest('[data-day-nav]');
    if (nav) {
      const delta = Number(nav.dataset.dayNav);
      shiftDayMonth(delta);
      renderDayCal();
      // innerHTML 换过以后原按钮已不在文档里，把焦点还给同一个翻月按钮，键盘操作不会中断
      const nextNav = els.dayCal.querySelector(`[data-day-nav="${delta}"]`);
      if (nextNav) nextNav.focus();
      return;
    }
    const dayCell = event.target.closest('[data-move-day]');
    if (!dayCell) return;
    moveTodoToDate(moveDayTodoId, dayCell.dataset.moveDay);
  });

  els.cloneDialog.addEventListener('close', () => {
    cloneContext = null;
    els.clonePicker.innerHTML = '';
  });
  els.cloneDialog.addEventListener('click', event => {
    if (event.target === els.cloneDialog) {
      els.cloneDialog.close();
      return;
    }
    if (!cloneContext) return;
    const pattern = event.target.closest('[data-clone-pattern]');
    if (pattern) {
      selectClonePattern(pattern.dataset.clonePattern);
      return;
    }
    const nav = event.target.closest('[data-clone-nav]');
    if (nav) {
      const delta = Number(nav.dataset.cloneNav);
      const base = parseKey(cloneContext.cursor);
      const next = dateKey(new Date(base.getFullYear(), base.getMonth() + delta, 1));
      if (validKey(next)) cloneContext.cursor = next;
      cloneContext.advancedOpen = false;
      renderClonePicker(`[data-clone-nav="${delta}"]`);
      return;
    }
    const field = event.target.closest('[data-clone-field]');
    if (field && !field.disabled) {
      cloneContext.field = field.dataset.cloneField;
      const key = cloneContext[cloneContext.field] || cloneContext.start;
      if (key) cloneContext.cursor = dateKey(startOfMonth(parseKey(key)));
      cloneContext.advancedOpen = false;
      renderClonePicker(`[data-clone-field="${cloneContext.field}"]`);
      return;
    }
    const day = event.target.closest('[data-clone-day]');
    if (day && !day.disabled) {
      selectCloneDay(day.dataset.cloneDay);
      return;
    }
    const action = event.target.closest('[data-clone-action]');
    const kind = action ? action.dataset.cloneAction : null;
    if (kind === 'cancel') els.cloneDialog.close();
    else if (kind === 'submit') submitClone();
    else if (kind === 'advanced') {
      cloneContext.advancedOpen = !cloneContext.advancedOpen;
      renderClonePicker(cloneContext.advancedOpen ? '[data-clone-pattern]' : '[data-clone-action="advanced"]');
    } else if (cloneContext.advancedOpen && !event.target.closest('.clone-advanced')) {
      cloneContext.advancedOpen = false;
      renderClonePicker('[data-clone-action="advanced"]');
    }
  });
  els.cloneDialog.addEventListener('keydown', event => {
    if (!cloneContext || !cloneContext.advancedOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cloneContext.advancedOpen = false;
      renderClonePicker('[data-clone-action="advanced"]');
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const options = $$('[data-clone-pattern]', els.clonePicker);
      const index = options.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next].focus();
    }
  });

  els.moveNew.addEventListener('click', () => {
    if (pickContext) {
      const context = pickContext;
      pickContext = null;
      els.moveDialog.close();
      openGroupDialog({ mode: 'create', createTodo: context });
      return;
    }
    const pending = moveTodoId;
    moveTodoId = null;
    els.moveDialog.close();
    openGroupDialog({ mode: 'create', moveTodoId: pending });
  });

  // 通知弹窗：纯文字提示（如新建分组后不占位），×/知道了/点遮罩均可关闭，Esc 走浏览器原生 cancel
  els.noticeClose.addEventListener('click', () => els.noticeDialog.close());
  els.noticeOk.addEventListener('click', () => els.noticeDialog.close());
  els.noticeDialog.addEventListener('click', event => {
    if (event.target === els.noticeDialog) els.noticeDialog.close();
  });

  els.exportBtn.addEventListener('click', exportData);
  els.importBtn.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', () => {
    const file = els.importFile.files && els.importFile.files[0];
    if (file) importData(file);
  });

  els.menuBtn.addEventListener('click', () => {
    if (document.body.classList.contains('nav-open')) closeDrawer();
    else openDrawer();
  });
  els.navClose.addEventListener('click', closeDrawer);
  els.scrim.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeDrawer();
      closeMenu();
      if (rangeOpen) {
        rangeOpen = false;
        calField = null;
        if (mode === 'overview') renderOverview(todayKey());
      }
    }
    if ((event.key === 'n' || event.key === 'N') && !isTyping() && !document.querySelector('dialog[open]') && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      openCreate(mode === 'day' ? selectedDate : todayKey());
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) closeDrawer();
  });

  window.addEventListener('storage', event => {
    if (event.key !== STORE_KEY) return;
    load();
    renderAll();
    if (els.cloneDialog.open) renderClonePicker();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      checkDayChange();
      pullCloud();
    }
  });
  window.addEventListener('focus', () => pullCloud());

  setInterval(checkDayChange, 30000);
  setInterval(() => {
    if (!document.hidden) pullCloud();
  }, CLOUD_PULL_MS);

  load();
  const today = todayKey();
  selectedDate = today;
  calendarCursor = startOfMonth(new Date());
  renderAll();
  initSync();
})();
