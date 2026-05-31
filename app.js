/* ── State ─────────────────────────────────────────────────── */
let state = {
  projects: [],
  activeProjectId: null,
};

/* ── Persistence ────────────────────────────────────────────── */
function save() {
  localStorage.setItem('teamflow_v1', JSON.stringify(state));
}

function load() {
  try {
    const raw = localStorage.getItem('teamflow_v1');
    if (raw) state = JSON.parse(raw);
  } catch (_) { /* fresh start */ }
}

/* ── Helpers ────────────────────────────────────────────────── */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const AVATAR_COLORS = [
  '#6366f1','#8b5cf6','#ec4899','#f59e0b',
  '#10b981','#3b82f6','#ef4444','#14b8a6','#f97316',
];

function avatarColor(name) {
  if (!name) return '#64748b';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dueCls(iso) {
  if (!iso) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(iso + 'T00:00:00');
  const diff = (due - today) / 86400000;
  if (diff < 0) return 'overdue';
  if (diff <= 2) return 'due-soon';
  return '';
}

function getProject(id) {
  return state.projects.find(p => p.id === id);
}

function getActiveProject() {
  return state.activeProjectId ? getProject(state.activeProjectId) : null;
}

function allAssignees(project) {
  const names = new Set();
  (project?.tasks || []).forEach(t => { if (t.assignee) names.add(t.assignee); });
  return [...names].sort();
}

/* ── Rendering ─────────────────────────────────────────────── */
function renderAll() {
  renderSidebar();
  renderBoard();
}

function renderSidebar() {
  const list = document.getElementById('projectList');
  const avatarsEl = document.getElementById('memberAvatars');
  list.innerHTML = '';

  state.projects.forEach(p => {
    const item = document.createElement('div');
    item.className = 'project-item' + (p.id === state.activeProjectId ? ' active' : '');
    item.dataset.id = p.id;

    const totalTasks = (p.tasks || []).length;
    item.innerHTML = `
      <span class="project-dot" style="background:${p.color}"></span>
      <span class="project-name">${escHtml(p.name)}</span>
      <span class="project-count">${totalTasks}</span>
      <button class="project-menu-btn" data-id="${p.id}" aria-label="Project menu" title="Options">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="12" cy="5" r="1.2" fill="currentColor" stroke="none"/>
          <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>
          <circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"/>
        </svg>
      </button>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.project-menu-btn') || e.target.closest('.project-dropdown')) return;
      setActiveProject(p.id);
    });

    item.querySelector('.project-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openProjectDropdown(e.currentTarget, p.id);
    });

    list.appendChild(item);
  });

  // Member avatars from active project
  const proj = getActiveProject();
  const members = proj ? allAssignees(proj) : [];
  avatarsEl.innerHTML = members.slice(0, 8).map(n => `
    <div class="avatar" style="background:${avatarColor(n)}" title="${escHtml(n)}">
      ${initials(n)}
    </div>
  `).join('');
}

function renderBoard() {
  const board = document.getElementById('board');
  const proj = getActiveProject();
  const addBtn = document.getElementById('addTaskBtn');
  const filters = document.getElementById('boardFilters');
  const title = document.getElementById('projectTitle');
  const subtitle = document.getElementById('projectSubtitle');

  if (!proj) {
    board.innerHTML = '';
    board.appendChild(document.getElementById('emptyState') || createEmptyState());
    document.getElementById('emptyState').style.display = 'flex';
    addBtn.disabled = true;
    filters.style.display = 'none';
    title.textContent = 'Select a project';
    subtitle.textContent = '';
    return;
  }

  title.textContent = proj.name;
  const total = (proj.tasks || []).length;
  const done = (proj.tasks || []).filter(t => t.status === 'done').length;
  subtitle.textContent = `${done}/${total} tasks complete`;
  addBtn.disabled = false;
  filters.style.display = 'flex';

  // Update filter assignees
  updateAssigneeFilter(proj);

  // Update stats
  renderStats(proj);

  const filterPriority = document.getElementById('filterPriority').value;
  const filterAssignee = document.getElementById('filterAssignee').value;
  const search = document.getElementById('searchInput').value.toLowerCase().trim();

  const columns = [
    { id: 'todo',       label: 'To Do',       cls: 'col-todo' },
    { id: 'inprogress', label: 'In Progress',  cls: 'col-inprogress' },
    { id: 'done',       label: 'Done',         cls: 'col-done' },
  ];

  board.innerHTML = '';

  columns.forEach(col => {
    const tasks = (proj.tasks || []).filter(t => {
      if (t.status !== col.id) return false;
      if (filterPriority && t.priority !== filterPriority) return false;
      if (filterAssignee && t.assignee !== filterAssignee) return false;
      if (search && !t.title.toLowerCase().includes(search) && !(t.description || '').toLowerCase().includes(search)) return false;
      return true;
    });

    const colEl = document.createElement('div');
    colEl.className = `column ${col.cls}`;
    colEl.innerHTML = `
      <div class="column-header">
        <span class="column-indicator"></span>
        <span class="column-title">${col.label}</span>
        <span class="column-badge">${tasks.length}</span>
      </div>
    `;

    const body = document.createElement('div');
    body.className = 'column-body';
    body.dataset.status = col.id;
    setupDropZone(body);

    if (tasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'column-empty';
      empty.textContent = 'No tasks';
      body.appendChild(empty);
    } else {
      tasks.forEach(task => {
        body.appendChild(createTaskCard(task));
      });
    }

    colEl.appendChild(body);
    board.appendChild(colEl);
  });
}

function createEmptyState() {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.id = 'emptyState';
  el.innerHTML = `
    <div class="empty-icon">
      <svg width="64" height="64" viewBox="0 0 28 28" fill="none">
        <rect width="12" height="12" rx="3" fill="#6366f1" opacity="0.4"/>
        <rect x="16" width="12" height="12" rx="3" fill="#8b5cf6" opacity="0.4"/>
        <rect y="16" width="12" height="12" rx="3" fill="#a78bfa" opacity="0.4"/>
        <rect x="16" y="16" width="12" height="12" rx="3" fill="#c4b5fd" opacity="0.4"/>
      </svg>
    </div>
    <h2>Welcome to TeamFlow</h2>
    <p>Create a project to get started tracking tasks with your team.</p>
    <button class="btn-primary" id="emptyCreateBtn">Create your first project</button>
  `;
  el.querySelector('#emptyCreateBtn').addEventListener('click', () => openProjectModal());
  return el;
}

function updateAssigneeFilter(proj) {
  const sel = document.getElementById('filterAssignee');
  const cur = sel.value;
  const names = allAssignees(proj);
  sel.innerHTML = `<option value="">All</option>` +
    names.map(n => `<option value="${escHtml(n)}"${n === cur ? ' selected' : ''}>${escHtml(n)}</option>`).join('');
}

function renderStats(proj) {
  const statsEl = document.getElementById('boardStats');
  const tasks = proj.tasks || [];
  const counts = { todo: 0, inprogress: 0, done: 0 };
  tasks.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });
  statsEl.innerHTML = `
    <span class="stat-item"><span class="stat-dot" style="background:#6366f1"></span>${counts.todo}</span>
    <span class="stat-item"><span class="stat-dot" style="background:#f59e0b"></span>${counts.inprogress}</span>
    <span class="stat-item"><span class="stat-dot" style="background:#10b981"></span>${counts.done}</span>
  `;
}

function createTaskCard(task) {
  const card = document.createElement('div');
  card.className = 'task-card';
  card.draggable = true;
  card.dataset.taskId = task.id;

  const dc = dueCls(task.dueDate);
  const dueHtml = task.dueDate ? `
    <span class="task-due ${dc}">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
      ${formatDate(task.dueDate)}${dc === 'overdue' ? ' !' : ''}
    </span>` : '';

  const assigneeHtml = task.assignee ? `
    <div class="task-assignee">
      <div class="assignee-avatar" style="background:${avatarColor(task.assignee)}">${initials(task.assignee)}</div>
      <span class="assignee-name">${escHtml(task.assignee)}</span>
    </div>` : '<div></div>';

  card.innerHTML = `
    <div class="task-priority-bar priority-${task.priority}"></div>
    <div class="task-header">
      <span class="task-title">${escHtml(task.title)}</span>
      <span class="task-badge badge-${task.priority}">${task.priority}</span>
    </div>
    ${task.description ? `<p class="task-description">${escHtml(task.description)}</p>` : ''}
    <div class="task-footer">
      ${assigneeHtml}
      <div class="task-meta">
        ${dueHtml}
        <button class="task-edit-btn" aria-label="Edit task">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
      </div>
    </div>
  `;

  card.querySelector('.task-edit-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openTaskModal(task);
  });

  card.addEventListener('click', () => openTaskModal(task));

  // Drag events
  card.addEventListener('dragstart', onDragStart);
  card.addEventListener('dragend', onDragEnd);

  return card;
}

/* ── Drag & Drop ────────────────────────────────────────────── */
let dragTaskId = null;
let dragPlaceholder = null;

function onDragStart(e) {
  dragTaskId = e.currentTarget.dataset.taskId;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragTaskId);

  dragPlaceholder = document.createElement('div');
  dragPlaceholder.className = 'task-card drag-placeholder';
  dragPlaceholder.style.height = e.currentTarget.offsetHeight + 'px';
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  if (dragPlaceholder && dragPlaceholder.parentNode) {
    dragPlaceholder.parentNode.removeChild(dragPlaceholder);
  }
  document.querySelectorAll('.column-body').forEach(b => b.classList.remove('drag-over'));
  dragTaskId = null;
  dragPlaceholder = null;
}

function setupDropZone(body) {
  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    body.classList.add('drag-over');

    const afterEl = getDragAfterElement(body, e.clientY);
    if (dragPlaceholder) {
      if (afterEl == null) {
        body.appendChild(dragPlaceholder);
      } else {
        body.insertBefore(dragPlaceholder, afterEl);
      }
    }
  });

  body.addEventListener('dragleave', (e) => {
    if (!body.contains(e.relatedTarget)) {
      body.classList.remove('drag-over');
    }
  });

  body.addEventListener('drop', (e) => {
    e.preventDefault();
    body.classList.remove('drag-over');
    if (!dragTaskId) return;

    const newStatus = body.dataset.status;
    const proj = getActiveProject();
    if (!proj) return;

    const task = proj.tasks.find(t => t.id === dragTaskId);
    if (!task) return;

    task.status = newStatus;
    task.updatedAt = new Date().toISOString();

    // Reorder within tasks array based on DOM position
    const afterEl = getDragAfterElement(body, e.clientY);
    const cards = [...body.querySelectorAll('.task-card:not(.drag-placeholder):not(.dragging)')];
    const afterId = afterEl ? afterEl.dataset.taskId : null;

    // Move task in array
    const taskIdx = proj.tasks.findIndex(t => t.id === dragTaskId);
    proj.tasks.splice(taskIdx, 1);

    if (afterId) {
      const afterIdx = proj.tasks.findIndex(t => t.id === afterId);
      proj.tasks.splice(afterIdx, 0, task);
    } else {
      // Find last task with this status and append after it
      let lastIdx = -1;
      proj.tasks.forEach((t, i) => { if (t.status === newStatus) lastIdx = i; });
      proj.tasks.splice(lastIdx + 1, 0, task);
    }

    save();
    renderAll();
  });
}

function getDragAfterElement(container, y) {
  const draggables = [...container.querySelectorAll('.task-card:not(.dragging):not(.drag-placeholder)')];
  return draggables.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

/* ── Project Modal ──────────────────────────────────────────── */
let editingProjectId = null;
let selectedColor = '#6366f1';

function openProjectModal(projectId = null) {
  editingProjectId = projectId;
  const modal = document.getElementById('projectModal');
  const title = document.getElementById('projectModalTitle');
  const submitBtn = document.getElementById('projectSubmitBtn');
  const nameEl = document.getElementById('projectName');
  const descEl = document.getElementById('projectDescription');

  if (projectId) {
    const proj = getProject(projectId);
    title.textContent = 'Edit Project';
    submitBtn.textContent = 'Save Changes';
    nameEl.value = proj.name;
    descEl.value = proj.description || '';
    selectColor(proj.color);
  } else {
    title.textContent = 'New Project';
    submitBtn.textContent = 'Create Project';
    document.getElementById('projectForm').reset();
    selectColor('#6366f1');
  }

  openModal('projectModal');
  nameEl.focus();
}

function selectColor(color) {
  selectedColor = color;
  document.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === color);
  });
}

document.getElementById('colorPicker').addEventListener('click', (e) => {
  const swatch = e.target.closest('.color-swatch');
  if (swatch) selectColor(swatch.dataset.color);
});

document.getElementById('projectForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('projectName').value.trim();
  const description = document.getElementById('projectDescription').value.trim();

  if (editingProjectId) {
    const proj = getProject(editingProjectId);
    proj.name = name;
    proj.description = description;
    proj.color = selectedColor;
    proj.updatedAt = new Date().toISOString();
  } else {
    const proj = {
      id: uid(),
      name,
      description,
      color: selectedColor,
      tasks: [],
      createdAt: new Date().toISOString(),
    };
    state.projects.push(proj);
    state.activeProjectId = proj.id;
  }

  save();
  closeModal('projectModal');
  renderAll();
});

/* ── Task Modal ─────────────────────────────────────────────── */
function openTaskModal(task = null, defaultStatus = 'todo') {
  const titleEl = document.getElementById('taskModalTitle');
  const submitBtn = document.getElementById('taskSubmitBtn');
  const deleteBtn = document.getElementById('deleteTaskBtn');
  const form = document.getElementById('taskForm');

  if (task) {
    titleEl.textContent = 'Edit Task';
    submitBtn.textContent = 'Save Changes';
    deleteBtn.style.display = 'flex';
    document.getElementById('taskId').value = task.id;
    document.getElementById('taskTitle').value = task.title;
    document.getElementById('taskDescription').value = task.description || '';
    document.getElementById('taskAssignee').value = task.assignee || '';
    document.getElementById('taskDueDate').value = task.dueDate || '';
    document.getElementById('taskPriority').value = task.priority || 'medium';
    document.getElementById('taskStatusSelect').value = task.status || 'todo';
  } else {
    titleEl.textContent = 'New Task';
    submitBtn.textContent = 'Add Task';
    deleteBtn.style.display = 'none';
    form.reset();
    document.getElementById('taskId').value = '';
    document.getElementById('taskStatusSelect').value = defaultStatus;
  }

  openModal('taskModal');
  document.getElementById('taskTitle').focus();
}

document.getElementById('taskForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const proj = getActiveProject();
  if (!proj) return;

  const id = document.getElementById('taskId').value;
  const title = document.getElementById('taskTitle').value.trim();
  const description = document.getElementById('taskDescription').value.trim();
  const assignee = document.getElementById('taskAssignee').value.trim();
  const dueDate = document.getElementById('taskDueDate').value;
  const priority = document.getElementById('taskPriority').value;
  const status = document.getElementById('taskStatusSelect').value;

  if (id) {
    const task = proj.tasks.find(t => t.id === id);
    if (task) {
      Object.assign(task, { title, description, assignee, dueDate, priority, status, updatedAt: new Date().toISOString() });
    }
  } else {
    proj.tasks.push({
      id: uid(),
      title,
      description,
      assignee,
      dueDate,
      priority,
      status,
      createdAt: new Date().toISOString(),
    });
  }

  save();
  closeModal('taskModal');
  renderAll();
});

document.getElementById('deleteTaskBtn').addEventListener('click', () => {
  const id = document.getElementById('taskId').value;
  if (!id) return;
  const proj = getActiveProject();
  if (!proj) return;
  proj.tasks = proj.tasks.filter(t => t.id !== id);
  save();
  closeModal('taskModal');
  renderAll();
});

/* ── Project Dropdown ───────────────────────────────────────── */
let activeDropdown = null;

function openProjectDropdown(btn, projectId) {
  closeDropdown();

  const dd = document.createElement('div');
  dd.className = 'project-dropdown';
  dd.innerHTML = `
    <button data-action="edit">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg>
      Edit
    </button>
    <button data-action="delete" class="danger">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
        <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
      </svg>
      Delete
    </button>
  `;

  dd.querySelector('[data-action="edit"]').addEventListener('click', () => {
    closeDropdown();
    openProjectModal(projectId);
  });

  dd.querySelector('[data-action="delete"]').addEventListener('click', () => {
    closeDropdown();
    openConfirmDelete(projectId);
  });

  btn.closest('.project-item').appendChild(dd);
  activeDropdown = dd;

  setTimeout(() => {
    document.addEventListener('click', closeDropdown, { once: true });
  }, 0);
}

function closeDropdown() {
  if (activeDropdown) {
    activeDropdown.remove();
    activeDropdown = null;
  }
}

/* ── Confirm Delete ─────────────────────────────────────────── */
let pendingDeleteId = null;

function openConfirmDelete(projectId) {
  pendingDeleteId = projectId;
  const proj = getProject(projectId);
  document.getElementById('confirmText').textContent =
    `Delete "${proj.name}"? This will permanently remove all ${(proj.tasks||[]).length} tasks. This cannot be undone.`;
  openModal('confirmModal');
}

document.getElementById('confirmDeleteBtn').addEventListener('click', () => {
  if (!pendingDeleteId) return;
  state.projects = state.projects.filter(p => p.id !== pendingDeleteId);
  if (state.activeProjectId === pendingDeleteId) state.activeProjectId = state.projects[0]?.id || null;
  pendingDeleteId = null;
  save();
  closeModal('confirmModal');
  renderAll();
});

/* ── Modal helpers ──────────────────────────────────────────── */
function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal(backdrop.id);
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.open').forEach(m => closeModal(m.id));
    closeDropdown();
  }
});

/* ── App controls ───────────────────────────────────────────── */
function setActiveProject(id) {
  state.activeProjectId = id;
  save();
  renderAll();
  closeMobileSidebar();
}

document.getElementById('newProjectBtn').addEventListener('click', () => openProjectModal());
document.getElementById('addTaskBtn').addEventListener('click', () => openTaskModal());
document.getElementById('emptyCreateBtn')?.addEventListener('click', () => openProjectModal());

document.getElementById('filterPriority').addEventListener('change', renderBoard);
document.getElementById('filterAssignee').addEventListener('change', renderBoard);
document.getElementById('searchInput').addEventListener('input', renderBoard);

/* ── Mobile sidebar ─────────────────────────────────────────── */
function openMobileSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('open');
}

function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

document.getElementById('mobileMenuBtn').addEventListener('click', openMobileSidebar);
document.getElementById('sidebarOverlay').addEventListener('click', closeMobileSidebar);

/* ── XSS protection ─────────────────────────────────────────── */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ── Init ───────────────────────────────────────────────────── */
load();

// Seed demo data on first run
if (state.projects.length === 0) {
  const demoProject = {
    id: uid(),
    name: 'Website Redesign',
    description: 'Revamp the company marketing site.',
    color: '#6366f1',
    tasks: [
      { id: uid(), title: 'Audit current site content', description: 'Review all pages for outdated content.', assignee: 'Alex Kim', dueDate: '', priority: 'medium', status: 'done', createdAt: new Date().toISOString() },
      { id: uid(), title: 'Design new homepage mockup', description: 'Create high-fidelity Figma designs for the hero and feature sections.', assignee: 'Sam Rivera', dueDate: getTomorrow(3), priority: 'high', status: 'inprogress', createdAt: new Date().toISOString() },
      { id: uid(), title: 'Set up Tailwind CSS', description: '', assignee: 'Alex Kim', dueDate: getTomorrow(1), priority: 'medium', status: 'inprogress', createdAt: new Date().toISOString() },
      { id: uid(), title: 'Write copy for About page', description: '', assignee: 'Jordan Lee', dueDate: getTomorrow(7), priority: 'low', status: 'todo', createdAt: new Date().toISOString() },
      { id: uid(), title: 'Implement contact form', description: 'Build and wire up the contact form with validation.', assignee: 'Sam Rivera', dueDate: getTomorrow(5), priority: 'medium', status: 'todo', createdAt: new Date().toISOString() },
      { id: uid(), title: 'Fix broken mobile nav', description: 'Hamburger menu does not close on link tap.', assignee: 'Alex Kim', dueDate: getTomorrow(-1), priority: 'critical', status: 'todo', createdAt: new Date().toISOString() },
    ],
    createdAt: new Date().toISOString(),
  };
  state.projects.push(demoProject);
  state.activeProjectId = demoProject.id;
  save();
}

function getTomorrow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

renderAll();
