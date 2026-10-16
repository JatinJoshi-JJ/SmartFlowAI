/**
 * SmartFlow AI Application Core
 */

// 1. Initialize Lenis Smooth Scrolling
let lenisInstance = null;
try {
  if (typeof Lenis !== "undefined") {
    lenisInstance = new Lenis({
      duration: 1.2,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      touchMultiplier: 1.5,
    });

    function raf(time) {
      lenisInstance.raf(time);
      requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);
  }
} catch (e) {
  console.warn("Lenis initialization skipped:", e);
}

// Defensive Event Listener Helper: Prevents "Cannot read properties of null (reading 'addEventListener')"
function safeOn(idOrElement, eventName, handler) {
  if (!idOrElement) return;
  const target =
    typeof idOrElement === "string"
      ? document.getElementById(idOrElement) ||
        document.querySelector(idOrElement)
      : idOrElement;

  if (target && typeof target.addEventListener === "function") {
    target.addEventListener(eventName, handler);
  }
}

// 2. State & Storage Architecture
const STORAGE_KEY_TASKS = "smartflow_tasks_v2";
const STORAGE_KEY_SESSIONS = "smartflow_focus_sessions_v2";
const STORAGE_KEY_THEME = "smartflow_theme_pref";

let appState = {
  tasks: [],
  focusSessions: [],
  activeFilter: "all",
  searchQuery: "",
  sortPreference: "dueDate",
  theme: "dark", // 'dark' | 'light' | 'system'
  activeFocusTaskId: null,
  focusDurationMinutes: 25,
  focusTimeRemaining: 25 * 60,
  isTimerRunning: false,
  timerIntervalId: null,
  deletedTaskBackup: null,
  activeBreakdownTask: null,
  currentBreakdownItems: [],
};

// 3. Audio Synth Engine (Web Audio API)
let audioCtx = null;
let isAudioPlaying = false;
let activeOscillators = [];
let gainNode = null;
let audioMode = "binaural";
let animationFrameId = null;

function initTheme() {
  const savedTheme = localStorage.getItem(STORAGE_KEY_THEME) || "dark";
  appState.theme = savedTheme;
  applyTheme(savedTheme);

  const themeSelect = document.getElementById("settingThemeSelect");
  if (themeSelect) themeSelect.value = savedTheme;
}

function applyTheme(theme) {
  const htmlEl = document.documentElement;
  if (theme === "system") {
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    htmlEl.classList.toggle("dark", prefersDark);
  } else if (theme === "light") {
    htmlEl.classList.remove("dark");
  } else {
    htmlEl.classList.add("dark");
  }
  localStorage.setItem(STORAGE_KEY_THEME, theme);
}

function toggleTheme() {
  const isCurrentlyDark = document.documentElement.classList.contains("dark");
  const nextTheme = isCurrentlyDark ? "light" : "dark";
  appState.theme = nextTheme;
  applyTheme(nextTheme);
  showToast(
    `Switched to ${nextTheme === "dark" ? "Dark Pitch" : "Clean Light"} mode`,
  );
}

const GEMINI_API_KEY = ""; // Zero-config runtime key

async function callGemini(promptText, systemInstruction = "") {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: promptText }],
      },
    ],
  };

  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  // If no API key is provided, trigger smart local deterministic heuristic fallback
  if (!GEMINI_API_KEY) {
    return null;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    console.warn(
      "Gemini API call failed, falling back to local deterministic model:",
      err,
    );
    return null;
  }
}

async function handleMagicNlpSubmit() {
  const input = document.getElementById("magicPromptInput");
  if (!input) return;
  const query = input.value.trim();
  if (!query) return;

  const btnText = document.getElementById("magicBtnText");
  const spinner = document.getElementById("magicLoadingSpinner");
  if (btnText) btnText.textContent = "Analyzing...";
  if (spinner) spinner.classList.remove("hidden");

  const todayStr = new Date().toISOString().split("T")[0];
  const systemPrompt = `You are a productivity task extraction engine. Given freeform text, return ONLY a valid JSON object without markdown formatting:
{
  "title": string (clean concise title),
  "description": string (context or empty),
  "priority": "high" | "medium" | "low",
  "category": "Development" | "Design" | "Study" | "Operations" | "Personal",
  "dueDate": string (YYYY-MM-DD format relative to today ${todayStr}, or null),
  "estimatedMinutes": number or null,
  "tags": array of strings (e.g. ["#dev", "#review"])
}`;

  let parsedTask = null;
  try {
    const rawResponse = await callGemini(query, systemPrompt);
    if (rawResponse) {
      const cleaned = rawResponse
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      parsedTask = JSON.parse(cleaned);
    }
  } catch (e) {
    console.warn("Gemini parse failed:", e);
  }

  // Fallback deterministic extractor if API returns null
  if (!parsedTask) {
    const isHigh = /urgent|asap|high|critical|important/i.test(query);
    const isLow = /low|someday|chill/i.test(query);
    const priority = isHigh ? "high" : isLow ? "low" : "medium";

    let category = "Development";
    if (/design|ui|ux|figma|logo/i.test(query)) category = "Design";
    else if (/study|learn|read|course|book/i.test(query)) category = "Study";
    else if (/call|email|meeting|admin|report/i.test(query))
      category = "Operations";
    else if (/gym|workout|health|doctor|groceries/i.test(query))
      category = "Personal";

    const tagMatches = query.match(/#[a-z0-9_-]+/gi) || [];
    const cleanTitle = query
      .replace(/#[a-z0-9_-]+/gi, "")
      .replace(/high priority|urgent|due tomorrow/gi, "")
      .trim();

    let dueDate = null;
    if (/tomorrow/i.test(query)) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      dueDate = d.toISOString().split("T")[0];
    } else if (/today/i.test(query)) {
      dueDate = todayStr;
    }

    parsedTask = {
      title: cleanTitle || query,
      description: "Parsed via SmartFlow Engine",
      priority,
      category,
      dueDate,
      estimatedMinutes: 30,
      tags: tagMatches,
    };
  }

  // Create Task
  createTask({
    title: parsedTask.title,
    description: parsedTask.description || "",
    priority: parsedTask.priority || "medium",
    category: parsedTask.category || "Development",
    dueDate: parsedTask.dueDate || null,
    estimatedMinutes: parsedTask.estimatedMinutes || null,
    tags: parsedTask.tags || [],
  });

  input.value = "";
  if (btnText) btnText.textContent = "✦ Parse & Add Task";
  if (spinner) spinner.classList.add("hidden");
  const container = document.getElementById("magicNlpContainer");
  if (container) container.classList.add("hidden");
  showToast(`Task "${parsedTask.title}" created via AI!`);
}

async function triggerTaskBreakdown(taskId) {
  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task) return;

  appState.activeBreakdownTask = task;
  const modal = document.getElementById("taskBreakdownModal");
  const titleEl = document.getElementById("breakdownParentTitle");
  const loading = document.getElementById("breakdownLoading");
  const list = document.getElementById("breakdownResultsList");

  if (!modal) return;
  if (titleEl) titleEl.textContent = task.title;
  if (loading) loading.classList.remove("hidden");
  if (list) list.classList.add("hidden");
  modal.classList.remove("hidden");
  modal.classList.add("flex");

  const systemPrompt = `You are a high-performance productivity coach. Break down this task into 3 to 5 realistic micro-steps. Return ONLY a valid JSON array:
[
  { "title": "Subtask title", "estimatedMins": 15 },
  ...
]`;

  let steps = null;
  try {
    const raw = await callGemini(
      `Task: "${task.title}". Context: "${task.description || "None"}"`,
      systemPrompt,
    );
    if (raw) {
      const clean = raw
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      steps = JSON.parse(clean);
    }
  } catch (err) {
    console.warn("AI breakdown fallback:", err);
  }

  if (!steps || !Array.isArray(steps)) {
    steps = [
      {
        title: `Clarify acceptance criteria for "${task.title}"`,
        estimatedMins: 10,
      },
      {
        title: "Draft initial outline or foundational implementation",
        estimatedMins: 25,
      },
      { title: "Execute core heavy-lifting milestones", estimatedMins: 45 },
      { title: "Final QA review, formatting, and sign-off", estimatedMins: 15 },
    ];
  }

  appState.currentBreakdownItems = steps;
  if (loading) loading.classList.add("hidden");
  if (list) {
    list.classList.remove("hidden");
    list.innerHTML = steps
      .map(
        (s, idx) => `
          <div class="p-3 rounded-xl bg-lightSurface-highlight dark:bg-obsidian-card border border-lightSurface-border dark:border-obsidian-border flex items-center justify-between text-xs">
            <div class="flex items-center gap-2.5">
              <input type="checkbox" checked id="step-cb-${idx}" class="accent-lime w-4 h-4 cursor-pointer">
              <label for="step-cb-${idx}" class="text-slate-800 dark:text-slate-200 font-medium">${s.title}</label>
            </div>
            <span class="text-[10px] font-mono text-emerald-600 dark:text-lime font-bold shrink-0">${s.estimatedMins || 20}m</span>
          </div>
        `,
      )
      .join("");
  }
}

function applyAdoptedSubtasks() {
  if (!appState.activeBreakdownTask || !appState.currentBreakdownItems) return;
  const task = appState.activeBreakdownTask;

  if (!task.subtasks) task.subtasks = [];
  appState.currentBreakdownItems.forEach((item, idx) => {
    const cb = document.getElementById(`step-cb-${idx}`);
    if (cb && cb.checked) {
      task.subtasks.push({
        id: "sub_" + Math.random().toString(36).substr(2, 9),
        title: item.title,
        completed: false,
        estimatedMins: item.estimatedMins || 15,
      });
    }
  });

  saveTasks();
  renderTasks();
  closeModal("taskBreakdownModal");
  showToast(`Added subtasks to "${task.title}"`);
}

async function generateAiExecutiveBriefing() {
  const activeTasks = appState.tasks.filter((t) => !t.completed);
  const overdueTasks = activeTasks.filter((t) => isTaskOverdue(t));
  const container = document.getElementById("aiBriefingContainer");
  const content = document.getElementById("aiBriefingContent");

  if (!container || !content) return;

  container.classList.remove("hidden");
  content.innerHTML = `<div class="py-2 text-slate-500 dark:text-slate-400">Synthesizing executive briefing with Gemini...</div>`;

  const prompt = `Review my current task load:
- Total active: ${activeTasks.length}
- Overdue tasks: ${overdueTasks.map((t) => t.title).join(", ") || "None"}
- Top pending tasks: ${
    activeTasks
      .slice(0, 5)
      .map((t) => `${t.title} (${t.priority} priority)`)
      .join(", ") || "None"
  }

Provide 3 bullet points:
1. "The One Big Domino" (what to tackle first right now)
2. "Sequencing & Momentum" (suggested Pomodoro order)
3. "Executive Rule" (a decisive one-line mindset prompt)`;

  let resultText = await callGemini(
    prompt,
    "You are an elite productivity strategist. Give crisp, direct advice.",
  );

  if (!resultText) {
    resultText =
      overdueTasks.length > 0
        ? `• **The One Big Domino:** Immediately eliminate overdue items ("${overdueTasks[0].title}") before touching new work.\n• **Sequencing:** Allocate one 25m Pomodoro to complete the most difficult task first.\n• **Executive Rule:** Motion is not progress; finish one meaningful objective before noon.`
        : `• **The One Big Domino:** Tackle your highest priority target: "${activeTasks[0]?.title || "Plan sprint"}" first.\n• **Sequencing:** Run 2 consecutive 25m Pomodoros followed by a 15m restorative break.\n• **Executive Rule:** Protect your focus from low-value multitasking.`;
  }

  content.innerHTML = resultText
    .replace(/\n/g, "<br>")
    .replace(
      /\*\*(.*?)\*\*/g,
      '<strong class="text-slate-900 dark:text-lime">$1</strong>',
    );
}

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TASKS);
    appState.tasks = raw ? JSON.parse(raw) : getInitialStarterTasks();
  } catch (e) {
    appState.tasks = getInitialStarterTasks();
  }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY_TASKS, JSON.stringify(appState.tasks));
  updateMetrics();
  renderTasks();
  renderAnalytics();
  evaluateAchievements();
}

function getInitialStarterTasks() {
  const today = new Date().toISOString().split("T")[0];
  return [
    {
      id: "task_init_1",
      title: "Review System Design & Frontend Architecture",
      description:
        "Ensure token alignment, WCAG contrast, and reactive state management.",
      priority: "high",
      category: "Development",
      dueDate: today,
      estimatedMinutes: 45,
      tags: ["#architecture", "#core"],
      completed: false,
      createdAt: new Date().toISOString(),
      completedAt: null,
      subtasks: [
        {
          id: "sub_1",
          title: "Verify responsive breakpoints",
          completed: true,
        },
        {
          id: "sub_2",
          title: "Audit color tokens for light & dark mode",
          completed: false,
        },
      ],
    },
    {
      id: "task_init_2",
      title: "Test Web Audio Ambient Soundscapes",
      description:
        "Synthesize 432Hz focus pulses and check waveform rendering.",
      priority: "medium",
      category: "Study",
      dueDate: today,
      estimatedMinutes: 25,
      tags: ["#audio", "#focus"],
      completed: true,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      completedAt: new Date().toISOString(),
      subtasks: [],
    },
  ];
}

function createTask(taskData) {
  const newTask = {
    id: "task_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
    title: taskData.title.trim(),
    description: taskData.description ? taskData.description.trim() : "",
    priority: taskData.priority || "medium",
    category: taskData.category || "Development",
    dueDate: taskData.dueDate || null,
    estimatedMinutes: taskData.estimatedMinutes
      ? parseInt(taskData.estimatedMinutes, 10)
      : null,
    tags: Array.isArray(taskData.tags)
      ? taskData.tags
      : parseTags(taskData.tags || ""),
    completed: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
    subtasks: [],
  };

  appState.tasks.unshift(newTask);
  saveTasks();
  return newTask;
}

function parseTags(tagStr) {
  if (!tagStr) return [];
  return tagStr
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => (t.startsWith("#") ? t : `#${t}`));
}

function toggleTaskComplete(taskId) {
  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task) return;

  task.completed = !task.completed;
  task.completedAt = task.completed ? new Date().toISOString() : null;
  saveTasks();
  showToast(
    task.completed
      ? `Completed "${task.title}"! 🎉`
      : `Reopened "${task.title}"`,
  );
}

function deleteTask(taskId) {
  const idx = appState.tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return;

  appState.deletedTaskBackup = { task: { ...appState.tasks[idx] }, index: idx };
  appState.tasks.splice(idx, 1);
  saveTasks();
  showToast("Task deleted", true);
}

function restoreLastDeletedTask() {
  if (!appState.deletedTaskBackup) return;
  appState.tasks.splice(
    appState.deletedTaskBackup.index,
    0,
    appState.deletedTaskBackup.task,
  );
  appState.deletedTaskBackup = null;
  saveTasks();
  showToast("Task restored successfully!");
}

function isTaskOverdue(task) {
  if (task.completed || !task.dueDate) return false;
  const today = new Date().toISOString().split("T")[0];
  return task.dueDate < today;
}

function isTaskDueToday(task) {
  if (!task.dueDate) return false;
  const today = new Date().toISOString().split("T")[0];
  return task.dueDate === today;
}

function renderTasks() {
  const container = document.getElementById("tasksListContainer");
  const emptyState = document.getElementById("emptyTasksState");
  const badgeCount = document.getElementById("filteredCountBadge");

  if (!container) return;

  let filtered = appState.tasks.filter((t) => {
    // Tab Filters
    if (appState.activeFilter === "today" && !isTaskDueToday(t)) return false;
    if (appState.activeFilter === "upcoming") {
      const today = new Date().toISOString().split("T")[0];
      if (!t.dueDate || t.dueDate <= today || t.completed) return false;
    }
    if (appState.activeFilter === "overdue" && !isTaskOverdue(t)) return false;
    if (appState.activeFilter === "active" && t.completed) return false;
    if (appState.activeFilter === "completed" && !t.completed) return false;

    // Search Query
    if (appState.searchQuery) {
      const q = appState.searchQuery.toLowerCase();
      const matchTitle = t.title.toLowerCase().includes(q);
      const matchDesc = (t.description || "").toLowerCase().includes(q);
      const matchTag = (t.tags || []).some((tag) =>
        tag.toLowerCase().includes(q),
      );
      const matchCat = t.category.toLowerCase().includes(q);
      if (!matchTitle && !matchDesc && !matchTag && !matchCat) return false;
    }
    return true;
  });

  // Sorting
  filtered.sort((a, b) => {
    if (appState.sortPreference === "priority") {
      const weights = { high: 3, medium: 2, low: 1 };
      return (weights[b.priority] || 0) - (weights[a.priority] || 0);
    }
    if (appState.sortPreference === "newest") {
      return new Date(b.createdAt) - new Date(a.createdAt);
    }
    if (appState.sortPreference === "title") {
      return a.title.localeCompare(b.title);
    }
    // Due Date default
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  });

  if (badgeCount) badgeCount.textContent = `${filtered.length} tasks`;

  if (filtered.length === 0) {
    container.innerHTML = "";
    if (emptyState) emptyState.classList.remove("hidden");
    return;
  }

  if (emptyState) emptyState.classList.add("hidden");

  container.innerHTML = filtered
    .map((t) => {
      const overdue = isTaskOverdue(t);
      const dueToday = isTaskDueToday(t);

      const priorityColors =
        {
          high: "bg-rose-500/10 text-rose-500 border-rose-500/30",
          medium: "bg-amber-500/10 text-amber-500 border-amber-500/30",
          low: "bg-slate-500/10 text-slate-500 border-slate-500/30",
        }[t.priority] || "bg-slate-500/10 text-slate-400";

      const subtasksTotal = (t.subtasks || []).length;
      const subtasksDone = (t.subtasks || []).filter(
        (st) => st.completed,
      ).length;

      return `
          <div class="group bg-white dark:bg-obsidian-card border ${overdue ? "border-rose-500/60 dark:border-rose-500/50" : "border-lightSurface-border dark:border-obsidian-border"} hover:border-lime/50 rounded-2xl p-4 transition-all duration-200 shadow-sm">
            <div class="flex items-start justify-between gap-3">
              
              <!-- Checkbox & Title Details -->
              <div class="flex items-start gap-3 flex-1 min-w-0">
                <button onclick="toggleTaskComplete('${t.id}')" class="mt-0.5 w-5 h-5 rounded-lg border-2 ${t.completed ? "bg-emerald-500 dark:bg-lime border-emerald-500 dark:border-lime text-black" : "border-slate-300 dark:border-obsidian-border hover:border-lime"} flex items-center justify-center transition shrink-0" aria-label="Toggle task completion">
                  ${t.completed ? '<svg class="w-3.5 h-3.5 stroke-[3]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>' : ""}
                </button>

                <div class="flex-1 min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <h3 class="font-display font-bold text-sm sm:text-base text-slate-900 dark:text-white truncate ${t.completed ? "line-through text-slate-400 dark:text-slate-500" : ""}">
                      ${t.title}
                    </h3>
                    <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-pill border ${priorityColors}">
                      ${t.priority}
                    </span>
                    <span class="text-[10px] text-slate-500 dark:text-slate-400 font-mono bg-lightSurface-highlight dark:bg-obsidian px-2 py-0.5 rounded-pill border border-lightSurface-border dark:border-obsidian-border">
                      ${t.category}
                    </span>
                    ${overdue ? '<span class="text-[10px] font-bold text-rose-500 bg-rose-500/10 px-2 py-0.5 rounded-pill border border-rose-500/30">OVERDUE</span>' : ""}
                    ${dueToday ? '<span class="text-[10px] font-bold text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-pill border border-amber-500/30">TODAY</span>' : ""}
                  </div>

                  ${t.description ? `<p class="text-xs text-slate-600 dark:text-slate-400 mt-1 line-clamp-2">${t.description}</p>` : ""}

                  <!-- Tags, Duration, and Subtask Progress -->
                  <div class="flex flex-wrap items-center gap-3 mt-2.5 text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                    ${
                      t.dueDate
                        ? `
                      <span class="flex items-center gap-1">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                        <span>Due: ${t.dueDate}</span>
                      </span>
                    `
                        : ""
                    }

                    ${
                      t.estimatedMinutes
                        ? `
                      <span class="flex items-center gap-1">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                        <span>${t.estimatedMinutes} mins</span>
                      </span>
                    `
                        : ""
                    }

                    ${
                      subtasksTotal > 0
                        ? `
                      <span class="text-emerald-600 dark:text-lime font-mono text-[10px]">
                        [${subtasksDone}/${subtasksTotal} Subtasks]
                      </span>
                    `
                        : ""
                    }

                    ${(t.tags || []).map((tag) => `<span class="text-blue-500 dark:text-blue-400 font-mono">${tag}</span>`).join(" ")}
                  </div>

                  <!-- Subtasks Checklist (if any exist) -->
                  ${
                    subtasksTotal > 0
                      ? `
                    <div class="mt-3 pt-2.5 border-t border-lightSurface-border dark:border-obsidian-border/50 space-y-1.5">
                      ${t.subtasks
                        .map(
                          (st, sIdx) => `
                        <div class="flex items-center gap-2 text-xs">
                          <input type="checkbox" ${st.completed ? "checked" : ""} onchange="toggleSubtask('${t.id}', '${st.id}')" id="st_${st.id}" class="accent-lime w-3.5 h-3.5 cursor-pointer">
                          <label for="st_${st.id}" class="${st.completed ? "line-through text-slate-400" : "text-slate-700 dark:text-slate-300"} cursor-pointer">${st.title}</label>
                        </div>
                      `,
                        )
                        .join("")}
                    </div>
                  `
                      : ""
                  }
                </div>
              </div>

              <!-- Quick Task Actions -->
              <div class="flex items-center gap-1 shrink-0">
                <button onclick="setFocusTask('${t.id}')" class="p-2 rounded-xl bg-lightSurface-highlight dark:bg-obsidian border border-lightSurface-border dark:border-obsidian-border hover:border-lime/50 text-slate-600 dark:text-slate-300 hover:text-black dark:hover:text-lime transition" title="Set as Active Focus Target">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                </button>

                <button onclick="triggerTaskBreakdown('${t.id}')" class="p-2 rounded-xl bg-lime/20 dark:bg-lime/10 border border-lime/30 text-slate-900 dark:text-lime hover:bg-lime hover:text-black transition" title="Decompose via Gemini AI">
                  <span class="text-xs font-bold font-mono">✦ AI</span>
                </button>

                <button onclick="openEditTaskModal('${t.id}')" class="p-2 rounded-xl bg-lightSurface-highlight dark:bg-obsidian border border-lightSurface-border dark:border-obsidian-border text-slate-600 dark:text-slate-300 hover:text-black dark:hover:text-white transition" title="Edit Task">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                </button>

                <button onclick="deleteTask('${t.id}')" class="p-2 rounded-xl bg-lightSurface-highlight dark:bg-obsidian border border-lightSurface-border dark:border-obsidian-border hover:border-rose-500/50 text-slate-600 dark:text-slate-300 hover:text-rose-500 transition" title="Delete Task">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
              </div>

            </div>
          </div>
        `;
    })
    .join("");
}

function toggleSubtask(taskId, subtaskId) {
  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task || !task.subtasks) return;
  const st = task.subtasks.find((s) => s.id === subtaskId);
  if (st) {
    st.completed = !st.completed;
    saveTasks();
  }
}

function updateMetrics() {
  const total = appState.tasks.length;
  const completed = appState.tasks.filter((t) => t.completed).length;
  const active = total - completed;
  const overdue = appState.tasks.filter((t) => isTaskOverdue(t)).length;
  const today = appState.tasks.filter(
    (t) => isTaskDueToday(t) && !t.completed,
  ).length;
  const rate = total === 0 ? 0 : Math.round((completed / total) * 100);

  const elTotal = document.getElementById("metricTotalTasks");
  const elActive = document.getElementById("metricActiveTasks");
  const elCompleted = document.getElementById("metricCompletedTasks");
  const elToday = document.getElementById("metricTodayTasks");
  const elOverdue = document.getElementById("metricOverdueTasks");
  const elRate = document.getElementById("metricCompletionRate");

  if (elTotal) elTotal.textContent = total;
  if (elActive) elActive.textContent = active;
  if (elCompleted) elCompleted.textContent = completed;
  if (elToday) elToday.textContent = today;
  if (elOverdue) elOverdue.textContent = overdue;
  if (elRate) elRate.textContent = `${rate}%`;

  const path = document.getElementById("radialMeterPath");
  if (path) {
    path.setAttribute("stroke-dasharray", `${rate}, 100`);
  }
}

function renderAnalytics() {
  renderWeeklyVelocityChart();
  renderDistributionBars();
  renderRuleBasedInsights();
}

function renderWeeklyVelocityChart() {
  const container = document.getElementById("weeklyChartContainer");
  const totalCountLabel = document.getElementById("weeklyTotalCount");
  if (!container) return;

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const counts = [0, 0, 0, 0, 0, 0, 0];
  const now = new Date();

  appState.tasks.forEach((t) => {
    if (t.completed && t.completedAt) {
      const compDate = new Date(t.completedAt);
      const diffDays = Math.floor((now - compDate) / (1000 * 60 * 60 * 24));
      if (diffDays >= 0 && diffDays < 7) {
        const dayIdx = compDate.getDay();
        counts[dayIdx]++;
      }
    }
  });

  const maxVal = Math.max(...counts, 4);
  const totalWeekly = counts.reduce((a, b) => a + b, 0);
  if (totalCountLabel)
    totalCountLabel.textContent = `${totalWeekly} Completed this week`;

  container.innerHTML = days
    .map((day, idx) => {
      const heightPct = Math.round((counts[idx] / maxVal) * 100);
      const isToday = idx === now.getDay();
      return `
          <div class="flex-1 flex flex-col items-center h-full justify-end group">
            <span class="text-[10px] font-mono text-slate-500 mb-1 group-hover:text-lime transition">${counts[idx]}</span>
            <div class="w-full max-w-[28px] bg-slate-200 dark:bg-obsidian-border rounded-t-lg relative overflow-hidden h-full flex items-end">
              <div class="w-full ${isToday ? "bg-lime" : "bg-slate-400 dark:bg-slate-600"} group-hover:bg-lime transition-all duration-300 rounded-t-lg" style="height: ${Math.max(heightPct, 6)}%;"></div>
            </div>
            <span class="text-[10px] font-mono text-slate-500 mt-2 ${isToday ? "text-slate-900 dark:text-white font-bold" : ""}">${day}</span>
          </div>
        `;
    })
    .join("");
}

function renderDistributionBars() {
  const catContainer = document.getElementById("categoryDensityContainer");
  const priContainer = document.getElementById("priorityDensityContainer");
  const total = appState.tasks.length || 1;

  // Categories
  const categories = [
    "Development",
    "Design",
    "Study",
    "Operations",
    "Personal",
  ];
  const catCounts = {};
  categories.forEach((c) => (catCounts[c] = 0));
  appState.tasks.forEach((t) => {
    if (catCounts[t.category] !== undefined) catCounts[t.category]++;
  });

  if (catContainer) {
    catContainer.innerHTML = categories
      .map((cat) => {
        const count = catCounts[cat] || 0;
        const pct = Math.round((count / total) * 100);
        return `
            <div>
              <div class="flex justify-between text-[11px] mb-1">
                <span class="text-slate-700 dark:text-slate-300">${cat}</span>
                <span class="font-mono text-slate-500">${count} (${pct}%)</span>
              </div>
              <div class="w-full h-1.5 bg-slate-200 dark:bg-obsidian rounded-full overflow-hidden">
                <div class="h-full bg-lime rounded-full" style="width: ${pct}%"></div>
              </div>
            </div>
          `;
      })
      .join("");
  }

  // Priorities
  const priorities = ["high", "medium", "low"];
  const priCounts = { high: 0, medium: 0, low: 0 };
  appState.tasks.forEach((t) => {
    if (!t.completed && priCounts[t.priority] !== undefined)
      priCounts[t.priority]++;
  });

  if (priContainer) {
    priContainer.innerHTML = priorities
      .map((pri) => {
        const count = priCounts[pri];
        const pct = Math.round((count / total) * 100);
        const color =
          pri === "high"
            ? "bg-rose-500"
            : pri === "medium"
              ? "bg-amber-400"
              : "bg-slate-400";
        return `
            <div>
              <div class="flex justify-between text-[11px] mb-1">
                <span class="text-slate-700 dark:text-slate-300 capitalize">${pri} Priority</span>
                <span class="font-mono text-slate-500">${count}</span>
              </div>
              <div class="w-full h-1.5 bg-slate-200 dark:bg-obsidian rounded-full overflow-hidden">
                <div class="h-full ${color} rounded-full" style="width: ${pct}%"></div>
              </div>
            </div>
          `;
      })
      .join("");
  }
}

function renderRuleBasedInsights() {
  const list = document.getElementById("smartInsightsList");
  if (!list) return;

  const active = appState.tasks.filter((t) => !t.completed);
  const overdue = active.filter((t) => isTaskOverdue(t));
  const todayDue = active.filter((t) => isTaskDueToday(t));
  const highPri = active.filter((t) => t.priority === "high");

  const insights = [];

  if (overdue.length > 0) {
    insights.push({
      type: "danger",
      title: `${overdue.length} Overdue Objective${overdue.length > 1 ? "s" : ""}`,
      desc: "Re-prioritize or reschedule these tasks to maintain mental velocity.",
    });
  }

  if (todayDue.length > 0) {
    insights.push({
      type: "warning",
      title: `${todayDue.length} Due Before Midnight`,
      desc: "Kick off a deep focus session on your highest priority item.",
    });
  }

  if (highPri.length >= 3) {
    insights.push({
      type: "info",
      title: "High Priority Density",
      desc: "You have 3+ critical targets. Pick the single biggest domino first.",
    });
  }

  if (insights.length === 0) {
    insights.push({
      type: "success",
      title: "Workstream Clear & Calm",
      desc: "All immediate deadlines resolved. Ideal time for architectural or deep creative sprints.",
    });
  }

  list.innerHTML = insights
    .map(
      (ins) => `
        <div class="p-3 rounded-xl border border-lightSurface-border dark:border-obsidian-border bg-lightSurface-highlight dark:bg-obsidian-card text-xs">
          <span class="font-bold block text-slate-900 dark:text-white">${ins.title}</span>
          <p class="text-slate-600 dark:text-slate-400 mt-0.5">${ins.desc}</p>
        </div>
      `,
    )
    .join("");
}

function setFocusTask(taskId) {
  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task) return;

  appState.activeFocusTaskId = taskId;
  const titleEl = document.getElementById("focusCurrentTaskTitle");
  if (titleEl) titleEl.textContent = task.title;
  const studioSection = document.getElementById("focusStudio");
  if (studioSection) studioSection.scrollIntoView({ behavior: "smooth" });
  showToast(`Linked "${task.title}" to Focus Studio`);
}

function updateTimerDisplay() {
  const mins = Math.floor(appState.focusTimeRemaining / 60);
  const secs = appState.focusTimeRemaining % 60;
  const formatted = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  const digitsEl = document.getElementById("focusTimeDigits");
  if (digitsEl) digitsEl.textContent = formatted;

  const totalSecs = appState.focusDurationMinutes * 60;
  const progressFraction =
    (totalSecs - appState.focusTimeRemaining) / totalSecs;
  const circumference = 339.29;
  const offset = circumference - progressFraction * circumference;
  const ring = document.getElementById("focusProgressRing");
  if (ring) ring.style.strokeDashoffset = offset;
}

function toggleTimer() {
  if (appState.isTimerRunning) {
    pauseTimer();
  } else {
    startTimer();
  }
}

function startTimer() {
  if (appState.isTimerRunning) return;
  appState.isTimerRunning = true;

  const playIcon = document.getElementById("timerPlayIcon");
  const pauseIcon = document.getElementById("timerPauseIcon");
  if (playIcon) playIcon.classList.add("hidden");
  if (pauseIcon) pauseIcon.classList.remove("hidden");

  appState.timerIntervalId = setInterval(() => {
    if (appState.focusTimeRemaining > 0) {
      appState.focusTimeRemaining--;
      updateTimerDisplay();
    } else {
      completeFocusSession();
    }
  }, 1000);
}

function pauseTimer() {
  appState.isTimerRunning = false;
  clearInterval(appState.timerIntervalId);
  const playIcon = document.getElementById("timerPlayIcon");
  const pauseIcon = document.getElementById("timerPauseIcon");
  if (playIcon) playIcon.classList.remove("hidden");
  if (pauseIcon) pauseIcon.classList.add("hidden");
}

function resetTimer() {
  pauseTimer();
  appState.focusTimeRemaining = appState.focusDurationMinutes * 60;
  updateTimerDisplay();
}

function completeFocusSession() {
  pauseTimer();
  playCompletionTone();

  const sessionRecord = {
    id: "session_" + Date.now(),
    taskId: appState.activeFocusTaskId,
    durationMinutes: appState.focusDurationMinutes,
    timestamp: new Date().toISOString(),
  };

  appState.focusSessions.push(sessionRecord);
  localStorage.setItem(
    STORAGE_KEY_SESSIONS,
    JSON.stringify(appState.focusSessions),
  );

  updateFocusSessionStats();
  evaluateAchievements();
  resetTimer();
  showToast(
    `🎯 Focus Session Finished! Logged ${appState.focusDurationMinutes} deep work minutes.`,
  );
}

function updateFocusSessionStats() {
  const count = appState.focusSessions.length;
  const totalMinutes = appState.focusSessions.reduce(
    (sum, s) => sum + (s.durationMinutes || 0),
    0,
  );
  const countEl = document.getElementById("completedSessionsCount");
  const minEl = document.getElementById("completedFocusMinutes");
  if (countEl) countEl.textContent = count;
  if (minEl) minEl.textContent = totalMinutes;
}

function playCompletionTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.3); // A5
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.8);
  } catch (e) {
    console.warn("Tone play failed:", e);
  }
}

function initAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime);
    gainNode.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

function startSynthesizer() {
  initAudioContext();
  stopSynthesizer();

  activeOscillators = [];
  const now = audioCtx.currentTime;

  if (audioMode === "binaural") {
    // 432 Hz Binaural Beat pair
    const oscLeft = audioCtx.createOscillator();
    const oscRight = audioCtx.createOscillator();
    const pannerLeft = audioCtx.createStereoPanner
      ? audioCtx.createStereoPanner()
      : null;
    const pannerRight = audioCtx.createStereoPanner
      ? audioCtx.createStereoPanner()
      : null;

    oscLeft.type = "sine";
    oscRight.type = "sine";
    oscLeft.frequency.setValueAtTime(432, now);
    oscRight.frequency.setValueAtTime(440, now);

    if (pannerLeft && pannerRight) {
      pannerLeft.pan.setValueAtTime(-1, now);
      pannerRight.pan.setValueAtTime(1, now);
      oscLeft.connect(pannerLeft);
      oscRight.connect(pannerRight);
      pannerLeft.connect(gainNode);
      pannerRight.connect(gainNode);
    } else {
      oscLeft.connect(gainNode);
      oscRight.connect(gainNode);
    }

    oscLeft.start();
    oscRight.start();
    activeOscillators.push(oscLeft, oscRight);
  } else if (audioMode === "deepdrone") {
    // Ambient chord drone
    [108, 162, 216].forEach((freq) => {
      const osc = audioCtx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now);
      osc.connect(gainNode);
      osc.start();
      activeOscillators.push(osc);
    });
  } else if (audioMode === "whitenoise") {
    // Procedural soft pink/rain noise
    const bufferSize = audioCtx.sampleRate * 2;
    const noiseBuffer = audioCtx.createBuffer(
      1,
      bufferSize,
      audioCtx.sampleRate,
    );
    const output = noiseBuffer.getChannelData(0);
    let b0 = 0,
      b1 = 0,
      b2 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      output[i] = (b0 + b1 + b2) * 0.11;
    }
    const whiteNoiseSource = audioCtx.createBufferSource();
    whiteNoiseSource.buffer = noiseBuffer;
    whiteNoiseSource.loop = true;
    whiteNoiseSource.connect(gainNode);
    whiteNoiseSource.start();
    activeOscillators.push(whiteNoiseSource);
  }

  isAudioPlaying = true;
  const playIcon = document.getElementById("playIcon");
  const pauseIcon = document.getElementById("pauseIcon");
  const statusEl = document.getElementById("audioTrackStatus");
  const promptEl = document.getElementById("audioWavePrompt");
  if (playIcon) playIcon.classList.add("hidden");
  if (pauseIcon) pauseIcon.classList.remove("hidden");
  if (statusEl) statusEl.textContent = "FLOWING";
  if (promptEl) promptEl.classList.add("hidden");
  startWaveformAnimation();
}

function stopSynthesizer() {
  activeOscillators.forEach((node) => {
    try {
      node.stop();
    } catch (e) {}
  });
  activeOscillators = [];
  isAudioPlaying = false;
  const playIcon = document.getElementById("playIcon");
  const pauseIcon = document.getElementById("pauseIcon");
  const statusEl = document.getElementById("audioTrackStatus");
  if (playIcon) playIcon.classList.remove("hidden");
  if (pauseIcon) pauseIcon.classList.add("hidden");
  if (statusEl) statusEl.textContent = "PAUSED";
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  drawWaveform(false);
}

function drawWaveform(animate = false) {
  const canvas = document.getElementById("waveformCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#D4FF00";
  ctx.beginPath();

  const time = Date.now() * 0.005;
  const numLines = 40;
  const step = width / numLines;

  for (let i = 0; i < numLines; i++) {
    const x = i * step;
    const amp = animate
      ? Math.sin(time + i * 0.3) * (height * 0.35)
      : Math.sin(i * 0.5) * 5;
    const y = height / 2 + amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function startWaveformAnimation() {
  drawWaveform(true);
  if (isAudioPlaying) {
    animationFrameId = requestAnimationFrame(startWaveformAnimation);
  }
}

function evaluateAchievements() {
  const completedCount = appState.tasks.filter((t) => t.completed).length;
  const sessionCount = appState.focusSessions.length;
  let unlocked = 0;

  // First Step
  if (completedCount >= 1) {
    unlockBadge("badge-first-step", "Unlocked");
    unlocked++;
  }

  // Momentum Builder
  if (completedCount >= 5) {
    unlockBadge("badge-momentum", "5 / 5 Unlocked");
    unlocked++;
  } else {
    updateBadgeProgress("badge-momentum", `${completedCount} / 5 Done`);
  }

  // Focus Novice
  if (sessionCount >= 1) {
    unlockBadge("badge-focus", "Unlocked");
    unlocked++;
  }

  // Deadline Hero
  const beatDeadline = appState.tasks.some(
    (t) =>
      t.completed &&
      t.dueDate &&
      t.completedAt &&
      t.completedAt.split("T")[0] <= t.dueDate,
  );
  if (beatDeadline) {
    unlockBadge("badge-deadline", "Unlocked");
    unlocked++;
  }

  const badgeCountEl = document.getElementById("unlockedBadgesCount");
  if (badgeCountEl) badgeCountEl.textContent = `${unlocked} / 4 Unlocked`;
}

function unlockBadge(id, statusText) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("opacity-60", "opacity-50");
  el.classList.add("border-lime/50", "bg-lime/5");
  const status = el.querySelector(".badge-status");
  if (status) {
    status.textContent = statusText;
    status.classList.remove("text-slate-500");
    status.classList.add("text-emerald-600", "dark:text-lime", "font-bold");
  }
}

function updateBadgeProgress(id, statusText) {
  const el = document.getElementById(id);
  if (!el) return;
  const status = el.querySelector(".badge-status");
  if (status) status.textContent = statusText;
}

function showToast(message, allowUndo = false) {
  const toast = document.getElementById("toastNotification");
  const msg = document.getElementById("toastMessage");
  const undoBtn = document.getElementById("toastUndoBtn");

  if (!toast || !msg) return;

  msg.textContent = message;
  if (undoBtn) undoBtn.classList.toggle("hidden", !allowUndo);

  toast.classList.remove("translate-y-20", "opacity-0", "pointer-events-none");
  toast.classList.add("translate-y-0", "opacity-100");

  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.classList.add("translate-y-20", "opacity-0", "pointer-events-none");
    toast.classList.remove("translate-y-0", "opacity-100");
  }, 3500);
}

function openEditTaskModal(taskId) {
  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task) return;

  const idEl = document.getElementById("editTaskId");
  const titleEl = document.getElementById("editTaskTitle");
  const descEl = document.getElementById("editTaskDesc");
  const priEl = document.getElementById("editTaskPriority");
  const dueEl = document.getElementById("editTaskDueDate");

  if (idEl) idEl.value = task.id;
  if (titleEl) titleEl.value = task.title;
  if (descEl) descEl.value = task.description || "";
  if (priEl) priEl.value = task.priority;
  if (dueEl) dueEl.value = task.dueDate || "";

  const modal = document.getElementById("editTaskModal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
}

function handleEditTaskSubmit(e) {
  e.preventDefault();
  const idInput = document.getElementById("editTaskId");
  if (!idInput) return;
  const id = idInput.value;
  const task = appState.tasks.find((t) => t.id === id);
  if (!task) return;

  const titleInput = document.getElementById("editTaskTitle");
  const descInput = document.getElementById("editTaskDesc");
  const priInput = document.getElementById("editTaskPriority");
  const dueInput = document.getElementById("editTaskDueDate");

  if (titleInput) task.title = titleInput.value.trim();
  if (descInput) task.description = descInput.value.trim();
  if (priInput) task.priority = priInput.value;
  if (dueInput) task.dueDate = dueInput.value || null;

  saveTasks();
  closeModal("editTaskModal");
  showToast("Task updated successfully!");
}

function exportBackupJson() {
  const exportData = {
    version: "2.0.0",
    exportDate: new Date().toISOString(),
    tasks: appState.tasks,
    focusSessions: appState.focusSessions,
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `smartflow_backup_${new Date().toISOString().split("T")[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Database exported as JSON!");
}

function importBackupJson(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const parsed = JSON.parse(event.target.result);
      if (Array.isArray(parsed.tasks)) {
        appState.tasks = parsed.tasks;
        if (Array.isArray(parsed.focusSessions)) {
          appState.focusSessions = parsed.focusSessions;
          localStorage.setItem(
            STORAGE_KEY_SESSIONS,
            JSON.stringify(appState.focusSessions),
          );
        }
        saveTasks();
        closeModal("settingsModal");
        showToast("Database successfully restored!");
      } else {
        showToast("Invalid JSON file format!");
      }
    } catch (err) {
      showToast("Failed to parse backup JSON file!");
    }
  };
  reader.readAsText(file);
}

function bindEvents() {
  // Form Submission
  safeOn("createTaskForm", "submit", (e) => {
    e.preventDefault();
    const titleInput = document.getElementById("taskTitleInput");
    if (!titleInput) return;
    const titleVal = titleInput.value.trim();

    const validationMsg = document.getElementById("titleValidationMsg");
    if (!titleVal) {
      if (validationMsg) validationMsg.classList.remove("hidden");
      return;
    }
    if (validationMsg) validationMsg.classList.add("hidden");

    const descEl = document.getElementById("taskDescInput");
    const priEl = document.getElementById("selectedPriority");
    const catEl = document.getElementById("taskCategorySelect");
    const dueEl = document.getElementById("taskDueDateInput");
    const durEl = document.getElementById("taskDurationInput");
    const tagsEl = document.getElementById("taskTagsInput");

    createTask({
      title: titleVal,
      description: descEl ? descEl.value : "",
      priority: priEl ? priEl.value : "medium",
      category: catEl ? catEl.value : "Development",
      dueDate: dueEl ? dueEl.value : "",
      estimatedMinutes: durEl ? durEl.value : "",
      tags: tagsEl ? tagsEl.value : "",
    });

    const form = document.getElementById("createTaskForm");
    if (form) form.reset();

    document.querySelectorAll(".priority-choice-btn").forEach((btn) => {
      btn.classList.remove(
        "active-priority",
        "bg-amber-400/20",
        "text-amber-300",
        "border",
        "border-amber-400/30",
      );
      if (btn.dataset.priority === "medium") {
        btn.classList.add(
          "active-priority",
          "bg-amber-400/20",
          "text-amber-300",
          "border",
          "border-amber-400/30",
        );
      }
    });
    if (priEl) priEl.value = "medium";
    showToast("Task added to active workstream! 🚀");
  });

  // Priority Selectors in Form
  document.querySelectorAll(".priority-choice-btn").forEach((btn) => {
    safeOn(btn, "click", () => {
      document.querySelectorAll(".priority-choice-btn").forEach((b) => {
        b.classList.remove(
          "active-priority",
          "bg-amber-400/20",
          "text-amber-300",
          "border",
          "border-amber-400/30",
          "bg-rose-500/20",
          "text-rose-400",
          "bg-slate-500/20",
          "text-slate-200",
        );
      });
      const pri = btn.dataset.priority;
      const priEl = document.getElementById("selectedPriority");
      if (priEl) priEl.value = pri;
      btn.classList.add("active-priority");
      if (pri === "high")
        btn.classList.add(
          "bg-rose-500/20",
          "text-rose-400",
          "border",
          "border-rose-500/40",
        );
      else if (pri === "medium")
        btn.classList.add(
          "bg-amber-400/20",
          "text-amber-300",
          "border",
          "border-amber-400/40",
        );
      else
        btn.classList.add(
          "bg-slate-500/20",
          "text-slate-200",
          "border",
          "border-slate-500/40",
        );
    });
  });

  // Filter Tabs
  document.querySelectorAll(".filter-tab-btn").forEach((btn) => {
    safeOn(btn, "click", () => {
      document.querySelectorAll(".filter-tab-btn").forEach((b) => {
        b.classList.remove(
          "active-filter",
          "bg-lime",
          "text-black",
          "shadow-sm",
        );
        b.classList.add(
          "bg-white",
          "dark:bg-obsidian-card",
          "text-slate-600",
          "dark:text-slate-400",
        );
      });
      btn.classList.add("active-filter", "bg-lime", "text-black", "shadow-sm");
      btn.classList.remove(
        "bg-white",
        "dark:bg-obsidian-card",
        "text-slate-600",
        "dark:text-slate-400",
      );
      appState.activeFilter = btn.dataset.filter;
      renderTasks();
    });
  });

  // Search & Sort
  safeOn("taskSearchInput", "input", (e) => {
    appState.searchQuery = e.target.value.trim();
    renderTasks();
  });
  safeOn("taskSortSelect", "change", (e) => {
    appState.sortPreference = e.target.value;
    renderTasks();
  });

  // Focus Studio Controls
  safeOn("focusTogglePlayBtn", "click", toggleTimer);
  safeOn("focusResetBtn", "click", resetTimer);
  safeOn("focusSkipBtn", "click", completeFocusSession);

  safeOn("changeFocusTaskBtn", "click", () => {
    const workspace = document.getElementById("workspace");
    if (workspace) workspace.scrollIntoView({ behavior: "smooth" });
    showToast("Select any task card to set as focus target");
  });

  document.querySelectorAll(".timer-mode-btn").forEach((btn) => {
    safeOn(btn, "click", () => {
      document.querySelectorAll(".timer-mode-btn").forEach((b) => {
        b.classList.remove("active-timer-btn", "bg-lime", "text-black");
        b.classList.add(
          "bg-lightSurface-highlight",
          "dark:bg-obsidian",
          "text-slate-700",
          "dark:text-slate-300",
        );
      });
      btn.classList.add("active-timer-btn", "bg-lime", "text-black");
      btn.classList.remove(
        "bg-lightSurface-highlight",
        "dark:bg-obsidian",
        "text-slate-700",
        "dark:text-slate-300",
      );

      const dur = parseInt(btn.dataset.duration, 10);
      appState.focusDurationMinutes = dur;
      resetTimer();
    });
  });

  // Soundscape Controls
  const toggleAudioHandler = () => {
    if (isAudioPlaying) stopSynthesizer();
    else startSynthesizer();
  };
  safeOn("togglePlayAudioBtn", "click", toggleAudioHandler);
  safeOn("headerAudioToggle", "click", toggleAudioHandler);

  safeOn("audioVolume", "input", (e) => {
    if (gainNode && audioCtx)
      gainNode.gain.setValueAtTime(
        parseFloat(e.target.value),
        audioCtx.currentTime,
      );
  });

  document.querySelectorAll(".sound-mode-btn").forEach((btn) => {
    safeOn(btn, "click", () => {
      document.querySelectorAll(".sound-mode-btn").forEach((b) => {
        b.classList.remove("active-sound", "bg-lime", "text-black");
        b.classList.add("bg-slate-800", "text-slate-300");
      });
      btn.classList.add("active-sound", "bg-lime", "text-black");
      btn.classList.remove("bg-slate-800", "text-slate-300");
      audioMode = btn.dataset.sound;
      if (isAudioPlaying) startSynthesizer();
    });
  });

  // Gemini Features Trigger
  safeOn("toggleMagicNlpBtn", "click", () => {
    const c = document.getElementById("magicNlpContainer");
    if (c) {
      c.classList.toggle("hidden");
      if (!c.classList.contains("hidden")) {
        const promptInput = document.getElementById("magicPromptInput");
        if (promptInput) promptInput.focus();
      }
    }
  });
  safeOn("submitMagicPromptBtn", "click", handleMagicNlpSubmit);
  safeOn("magicPromptInput", "keydown", (e) => {
    if (e.key === "Enter") handleMagicNlpSubmit();
  });

  safeOn("generateAiBriefingBtn", "click", generateAiExecutiveBriefing);
  safeOn("closeAiBriefingBtn", "click", () => {
    const c = document.getElementById("aiBriefingContainer");
    if (c) c.classList.add("hidden");
  });

  safeOn("applyBreakdownBtn", "click", applyAdoptedSubtasks);
  safeOn("closeBreakdownModal", "click", () =>
    closeModal("taskBreakdownModal"),
  );
  safeOn("copyBreakdownBtn", "click", () => {
    const text = appState.currentBreakdownItems
      .map((s) => `- [ ] ${s.title} (${s.estimatedMins || 20}m)`)
      .join("\n");
    document.execCommand("copy");
    showToast("Breakdown plan copied to clipboard!");
  });

  // Theme Switcher & Settings
  safeOn("themeToggleBtn", "click", toggleTheme);
  safeOn("settingThemeSelect", "change", (e) => {
    applyTheme(e.target.value);
  });

  const openSettingsHandler = () => {
    const m = document.getElementById("settingsModal");
    if (m) {
      m.classList.remove("hidden");
      m.classList.add("flex");
    }
  };
  safeOn("navSettingsBtn", "click", openSettingsHandler);
  safeOn("footerSettingsTrigger", "click", openSettingsHandler);
  safeOn("mobileOpenSettings", "click", openSettingsHandler);

  safeOn("closeSettingsModal", "click", () => closeModal("settingsModal"));
  safeOn("editTaskForm", "submit", handleEditTaskSubmit);
  safeOn("closeEditModal", "click", () => closeModal("editTaskModal"));
  safeOn("cancelEditBtn", "click", () => closeModal("editTaskModal"));

  // Backup / Restore
  safeOn("exportDataBtn", "click", exportBackupJson);
  safeOn("importDataInput", "change", importBackupJson);
  safeOn("clearAllDataBtn", "click", () => {
    appState.tasks = [];
    appState.focusSessions = [];
    saveTasks();
    closeModal("settingsModal");
    showToast("All data successfully cleared.");
  });

  // FAQ Accordion
  document.querySelectorAll(".faq-btn").forEach((btn) => {
    safeOn(btn, "click", () => {
      const content = btn.nextElementSibling;
      const icon = btn.querySelector(".faq-icon");
      if (content) {
        const isClosed = content.classList.contains("hidden");
        content.classList.toggle("hidden");
        if (icon) icon.textContent = isClosed ? "−" : "+";
      }
    });
  });

  // Starter Task Buttons
  document.querySelectorAll(".starter-task-btn").forEach((btn) => {
    safeOn(btn, "click", () => {
      const title = btn.dataset.starter;
      createTask({
        title: title,
        description: "Generated from SmartFlow Starter Recommendation",
        priority: "medium",
        category: "Study",
        dueDate: new Date().toISOString().split("T")[0],
        estimatedMinutes: 30,
        tags: ["#starter"],
      });
      showToast(`Added starter task "${title}"`);
    });
  });

  // Header Quick Add button & Drawer
  safeOn("headerQuickAddBtn", "click", () => {
    const titleInput = document.getElementById("taskTitleInput");
    if (titleInput) titleInput.focus();
    const section = document.getElementById("quickCreateSection");
    if (section) section.scrollIntoView({ behavior: "smooth" });
  });

  safeOn("mobileMenuToggle", "click", () => {
    const drawer = document.getElementById("mobileDrawer");
    if (drawer) drawer.classList.toggle("hidden");
  });

  // Back to Top with Lenis
  safeOn("backToTopBtn", "click", () => {
    if (lenisInstance) {
      lenisInstance.scrollTo(0);
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  // Toast Undo Handler
  safeOn("toastUndoBtn", "click", restoreLastDeletedTask);

  // Dismiss Announcement Banner
  safeOn("dismissAnnouncementBtn", "click", () => {
    const bar = document.getElementById("announcementBar");
    if (bar) bar.style.display = "none";
  });

  // Apply Suggestion button
  safeOn("applySuggestionBtn", "click", () => {
    const priEl = document.getElementById("selectedPriority");
    if (priEl) priEl.value = "high";
    document.querySelectorAll(".priority-choice-btn").forEach((btn) => {
      btn.classList.remove(
        "active-priority",
        "bg-amber-400/20",
        "text-amber-300",
        "border",
        "border-amber-400/30",
        "bg-rose-500/20",
        "text-rose-400",
      );
      if (btn.dataset.priority === "high") {
        btn.classList.add(
          "active-priority",
          "bg-rose-500/20",
          "text-rose-400",
          "border",
          "border-rose-500/40",
        );
      }
    });
    showToast("Elevated task priority to High");
  });
}

function init() {
  // 1. Preloader Animation
  const bar = document.getElementById("preloaderBar");
  if (bar) bar.style.width = "100%";
  setTimeout(() => {
    const preloader = document.getElementById("preloader");
    if (preloader) {
      preloader.classList.add("opacity-0");
      setTimeout(() => (preloader.style.display = "none"), 500);
    }
  }, 400);

  // 2. Init App Data & Theme
  initTheme();
  loadTasks();
  try {
    const sessions = localStorage.getItem(STORAGE_KEY_SESSIONS);
    if (sessions) appState.focusSessions = JSON.parse(sessions);
  } catch (e) {}

  updateMetrics();
  renderTasks();
  renderAnalytics();
  evaluateAchievements();
  updateFocusSessionStats();
  updateTimerDisplay();
  drawWaveform(false);

  // 3. Live Clock Updater
  setInterval(() => {
    const now = new Date();
    const clock = document.getElementById("liveClock");
    if (clock) clock.textContent = now.toLocaleTimeString();
  }, 1000);

  // 4. Bind All Events Safely
  bindEvents();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
