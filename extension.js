import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/* ─── Constants ──────────────────────────────────────────────────────── */

const TASK_FILE = `${GLib.get_user_config_dir()}/reminders/tasks.json`;

const P = { NONE: 0, LOW: 1, MED: 2, HIGH: 3 };
const P_LABEL = ['—', 'L', 'M', 'H'];

// GNOME HIG semantic palette — these appear throughout Adwaita and feel native
const P_COLOR = [
    'transparent',
    '#3584e4',  // GNOME blue
    '#e66100',  // GNOME orange
    '#c01c28',  // GNOME red
];

const DUE_PRESETS = [
    { label: 'No due',    ms: null },
    { label: '+1 hour',   ms: () => Date.now() + 36e5 },
    { label: 'Today',     ms: () => { const d = new Date(); d.setHours(23, 59, 0, 0); return +d; } },
    { label: 'Tomorrow',  ms: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(23, 59, 0, 0); return +d; } },
    { label: 'Next week', ms: () => { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); return +d; } },
];

/* ─── Helpers ────────────────────────────────────────────────────────── */

function formatDue(ms) {
    if (!ms) return null;
    const diff = ms - Date.now();
    if (diff < 0) return { text: 'Overdue', overdue: true };
    const h = Math.floor(diff / 36e5);
    const m = Math.floor((diff % 36e5) / 6e4);
    if (h >= 48)    return { text: `${Math.floor(h / 24)}d`,  overdue: false };
    if (h > 0)      return { text: `${h}h ${m}m`,             overdue: false };
    if (m > 0)      return { text: `${m}m`,                   overdue: false };
    return { text: 'Now', overdue: false };
}

/* ─── Extension ──────────────────────────────────────────────────────── */

export default class RemindersExtension {

    constructor() {
        this._tasks       = [];
        this._filter      = 'active';
        this._newPri      = P.NONE;
        this._newDueIdx   = 0;
        this._interval    = null;
        this._menuOpenId  = null;
        this._reminderBox = null;
        this._vSep        = null;
        this._hbox        = null;
    }

    /* ── Storage ─────────────────────────────────────────────────────── */

    _load() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(TASK_FILE), 0o755);
            if (!GLib.file_test(TASK_FILE, GLib.FileTest.EXISTS)) return;
            const [ok, raw] = Gio.File.new_for_path(TASK_FILE).load_contents(null);
            if (!ok) return;
            const d = JSON.parse(new TextDecoder().decode(raw));
            this._tasks = (d.tasks || []).map((t, i) => ({
                id:        t.id        ?? (Date.now() + i),
                text:      t.text      ?? '',
                done:      t.done      ?? false,
                priority:  t.priority  ?? P.NONE,
                dueMs:     t.dueMs     ?? null,
                notified:  t.notified  ?? false,
                createdAt: t.createdAt ?? Date.now(),
            }));
        } catch (e) { console.error('[Reminders] load:', e); }
    }

    _save() {
        try {
            Gio.File.new_for_path(TASK_FILE).replace_contents(
                new TextEncoder().encode(JSON.stringify({ tasks: this._tasks }, null, 2)),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );
        } catch (e) { console.error('[Reminders] save:', e); }
    }

    /* ── Due-task checker ────────────────────────────────────────────── */

    _checkDue() {
        const now = Date.now();
        let dirty = false;
        for (const t of this._tasks) {
            if (!t.done && t.dueMs && !t.notified && t.dueMs <= now) {
                Main.notify('Reminder', t.text);
                t.notified = true;
                dirty = true;
            }
        }
        if (dirty) { this._save(); this._refresh(); }
        return GLib.SOURCE_CONTINUE;
    }

    /* ── Widget construction ─────────────────────────────────────────── */

    _buildWidget() {
        // No custom background — the datemenu-holder already has the panel styling.
        // We just set a width that matches the notification column (~300 px).
        this._reminderBox = new St.BoxLayout({
            vertical: true,
            style: 'min-width: 300px; max-width: 300px; padding: 16px 16px 12px;',
        });

        this._buildHeader();
        this._buildFilterBar();
        this._buildTaskList();
        this._buildAddBar();
    }

    /* ── Header ── */
    _buildHeader() {
        const row = new St.BoxLayout({ style: 'margin-bottom: 12px;' });

        // Use the same CSS class as GNOME's "Events" / "Messages" section titles
        const title = new St.Label({
            text: 'Reminders',
            style_class: 'events-section-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._countLbl = new St.Label({
            style: 'font-size: 11px; opacity: 0.55; margin-right: 8px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const clearBtn = new St.Button({
            label: 'Clear done',
            // 'button' style_class inherits Adwaita button theming automatically
            style_class: 'button',
            style: 'padding: 2px 8px; font-size: 11px;',
        });
        clearBtn.connect('clicked', () => {
            this._tasks = this._tasks.filter(t => !t.done);
            this._save();
            this._refresh();
        });

        row.add_child(title);
        row.add_child(this._countLbl);
        row.add_child(clearBtn);
        this._reminderBox.add_child(row);
    }

    /* ── Filter tabs ── */
    _buildFilterBar() {
        const row = new St.BoxLayout({ style: 'spacing: 4px; margin-bottom: 10px;' });
        this._fBtns = {};

        for (const [key, label] of [['all', 'All'], ['active', 'Active'], ['done', 'Done']]) {
            const b = new St.Button({
                label,
                style: this._fStyle(key === this._filter),
            });
            b.connect('clicked', () => {
                this._filter = key;
                for (const [k, fb] of Object.entries(this._fBtns))
                    fb.set_style(this._fStyle(k === this._filter));
                this._refresh();
            });
            this._fBtns[key] = b;
            row.add_child(b);
        }

        this._reminderBox.add_child(row);
    }

    _fStyle(active) {
        return active
            ? 'padding: 3px 14px; border-radius: 12px; background: rgba(255,255,255,0.18); font-size: 11px;'
            : 'padding: 3px 14px; border-radius: 12px; background: transparent; font-size: 11px; opacity: 0.5;';
    }

    /* ── Scrollable task list ── */
    _buildTaskList() {
        this._scroll = new St.ScrollView({
            style: 'max-height: 300px;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._list = new St.BoxLayout({ vertical: true, style: 'spacing: 2px;' });
        this._scroll.add_child(this._list);
        this._reminderBox.add_child(this._scroll);
    }

    /* ── Add bar ── */
    _buildAddBar() {
        // Thin rule — rgba so it adapts to light and dark Adwaita
        this._reminderBox.add_child(new St.Widget({
            style: 'height: 1px; background-color: rgba(127,127,127,0.25); margin: 8px 0;',
        }));

        const row = new St.BoxLayout({ style: 'spacing: 5px;' });

        // Priority cycle — starts as a neutral pill, gains GNOME colour on cycle
        this._priBtn = new St.Button({
            label: P_LABEL[this._newPri],
            style: this._pStyle(this._newPri),
        });
        this._priBtn.connect('clicked', () => {
            this._newPri = (this._newPri + 1) % 4;
            this._priBtn.set_label(P_LABEL[this._newPri]);
            this._priBtn.set_style(this._pStyle(this._newPri));
        });

        // Entry — inherits popup-menu text/bg via style_class
        this._entry = new St.Entry({
            hint_text: 'New reminder…',
            x_expand: true,
        });
        this._entry.clutter_text.connect('activate', () => this._addTask());

        // Due preset cycle
        this._dueBtn = new St.Button({
            label: DUE_PRESETS[0].label,
            style: this._dueStyle(false),
        });
        this._dueBtn.connect('clicked', () => {
            this._newDueIdx = (this._newDueIdx + 1) % DUE_PRESETS.length;
            this._dueBtn.set_label(DUE_PRESETS[this._newDueIdx].label);
            this._dueBtn.set_style(this._dueStyle(this._newDueIdx > 0));
        });

        // Add — GNOME blue accent, consistent with suggested-action buttons
        const addBtn = new St.Button({
            label: '+',
            style: 'padding: 4px 12px; border-radius: 6px; background: rgba(53,132,228,0.35); font-size: 15px; font-weight: bold;',
        });
        addBtn.connect('clicked', () => this._addTask());

        row.add_child(this._priBtn);
        row.add_child(this._entry);
        row.add_child(this._dueBtn);
        row.add_child(addBtn);
        this._reminderBox.add_child(row);
    }

    _pStyle(p) {
        const hasPri = p !== P.NONE;
        return `width: 24px; height: 24px; border-radius: 6px;
                background: ${hasPri ? P_COLOR[p] + '40' : 'rgba(127,127,127,0.2)'};
                ${hasPri ? `color: ${P_COLOR[p]};` : 'opacity: 0.6;'}
                font-size: 10px; font-weight: bold;`;
    }

    _dueStyle(active) {
        return active
            ? 'padding: 4px 8px; border-radius: 5px; font-size: 10px; background: rgba(53,132,228,0.2); color: #78aeed;'
            : 'padding: 4px 8px; border-radius: 5px; font-size: 10px; opacity: 0.5;';
    }

    /* ── CRUD ────────────────────────────────────────────────────────── */

    _addTask() {
        const text = this._entry.get_text().trim();
        if (!text) return;
        const preset = DUE_PRESETS[this._newDueIdx];
        this._tasks.unshift({
            id: Date.now(), text, done: false,
            priority: this._newPri,
            dueMs: preset.ms ? preset.ms() : null,
            notified: false, createdAt: Date.now(),
        });
        // Reset controls
        this._entry.set_text('');
        this._newPri    = P.NONE;
        this._newDueIdx = 0;
        this._priBtn.set_label(P_LABEL[P.NONE]);
        this._priBtn.set_style(this._pStyle(P.NONE));
        this._dueBtn.set_label(DUE_PRESETS[0].label);
        this._dueBtn.set_style(this._dueStyle(false));
        this._save();
        this._refresh();
    }

    _toggleDone(id) {
        const t = this._tasks.find(t => t.id === id);
        if (!t) return;
        t.done = !t.done;
        if (t.done) t.notified = true;
        this._save();
        this._refresh();
    }

    _deleteTask(id) {
        this._tasks = this._tasks.filter(t => t.id !== id);
        this._save();
        this._refresh();
    }

    /* ── Rendering ───────────────────────────────────────────────────── */

    _refresh() {
        this._list.destroy_all_children();

        const shown = this._tasks
            .filter(t => {
                if (this._filter === 'active') return !t.done;
                if (this._filter === 'done')   return t.done;
                return true;
            })
            .sort((a, b) => {
                if (a.done !== b.done) return a.done ? 1 : -1;
                if (b.priority !== a.priority) return b.priority - a.priority;
                if (a.dueMs && b.dueMs) return a.dueMs - b.dueMs;
                if (a.dueMs) return -1;
                if (b.dueMs) return 1;
                return b.createdAt - a.createdAt;
            });

        const active = this._tasks.filter(t => !t.done).length;
        this._countLbl.set_text(`${active} active`);

        if (shown.length === 0) {
            this._list.add_child(new St.Label({
                text: this._filter === 'done'
                    ? 'No completed tasks yet.'
                    : 'Nothing here — add one below.',
                style: 'font-size: 11px; opacity: 0.35; padding: 24px 0;',
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            }));
            return;
        }

        for (const task of shown)
            this._list.add_child(this._makeRow(task));
    }

    _makeRow(task) {
        const due     = formatDue(task.dueMs);
        const overdue = due?.overdue ?? false;

        const row = new St.BoxLayout({
            style: `padding: 5px 6px; border-radius: 6px; spacing: 6px;
                    background: ${
                        overdue     ? 'rgba(192,28,40,0.12)'    :
                        task.done   ? 'rgba(127,127,127,0.04)'  :
                                      'rgba(255,255,255,0.06)'
                    };`,
        });

        /* Checkbox — blue tick on done, faint border otherwise */
        const chk = new St.Button({
            label: task.done ? '✓' : '',
            style: `width: 16px; height: 16px; border-radius: 3px; font-size: 9px;
                    border: 1.5px solid ${task.done ? '#3584e4' : 'rgba(127,127,127,0.5)'};
                    background: ${task.done ? '#3584e4' : 'transparent'};`,
        });
        chk.connect('clicked', () => this._toggleDone(task.id));

        /* Coloured priority stripe */
        const pri = new St.Widget({
            style: `width: 3px; height: 16px; border-radius: 2px;
                    background: ${P_COLOR[task.priority ?? 0]};
                    opacity: ${task.priority ? 1 : 0};`,
        });

        /* Task text — click to edit inline */
        const txt = new St.Label({
            style: `font-size: 12px; opacity: ${task.done ? 0.38 : 0.92};`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        txt.clutter_text.use_markup = true;
        txt.clutter_text.set_markup(
            task.done
                ? `<s>${GLib.markup_escape_text(task.text, -1)}</s>`
                : GLib.markup_escape_text(task.text, -1)
        );
        txt.clutter_text.line_wrap = true;
        txt.reactive = true;
        txt.connect('button-press-event', () => this._startEdit(task, row, txt));

        /* Due badge */
        let dueBadge = null;
        if (due) {
            dueBadge = new St.Label({
                text: due.text,
                style: `font-size: 9px; padding: 1px 6px; border-radius: 3px;
                        background: ${overdue ? 'rgba(192,28,40,0.25)' : 'rgba(53,132,228,0.18)'};
                        opacity: ${overdue ? 1 : 0.75};`,
                y_align: Clutter.ActorAlign.CENTER,
            });
        }

        /* Delete — invisible until hover */
        const del = new St.Button({
            label: '✕',
            style: 'font-size: 9px; padding: 2px 4px; opacity: 0; border-radius: 3px;',
        });
        del.connect('clicked', () => this._deleteTask(task.id));

        // Show/hide delete on row hover
        row.reactive = true;
        row.connect('enter-event', () => del.set_style('font-size: 9px; padding: 2px 4px; opacity: 1; color: #c01c28; border-radius: 3px;'));
        row.connect('leave-event', () => del.set_style('font-size: 9px; padding: 2px 4px; opacity: 0; border-radius: 3px;'));

        row.add_child(chk);
        row.add_child(pri);
        row.add_child(txt);
        if (dueBadge) row.add_child(dueBadge);
        row.add_child(del);
        return row;
    }

    /* ── Inline edit ─────────────────────────────────────────────────── */

    _startEdit(task, row, txtLabel) {
        const entry = new St.Entry({
            text: task.text,
            x_expand: true,
            // No custom bg — inherit the panel's entry style via St.Entry defaults
        });

        let committed = false;
        const commit = () => {
            if (committed) return; committed = true;
            const v = entry.get_text().trim();
            if (v) { task.text = v; this._save(); }
            this._refresh();
        };

        entry.clutter_text.connect('activate', commit);
        entry.clutter_text.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) { committed = true; this._refresh(); }
            return Clutter.EVENT_PROPAGATE;
        });
        entry.clutter_text.connect('key-focus-out', commit);

        const children = row.get_children();
        const idx = children.indexOf(txtLabel);
        if (idx !== -1) { row.remove_child(txtLabel); row.insert_child_at_index(entry, idx); }
        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, -1);
    }

    /* ── Lifecycle ───────────────────────────────────────────────────── */

    enable() {
        try {
            this._load();
            this._buildWidget();
            this._refresh();

            const dm = Main.panel.statusArea.dateMenu;

            // In GNOME 45+, dateMenu._messageList (the notifications column) sits
            // directly inside the top-level datemenu-holder St.BoxLayout (horizontal).
            // Inserting our box before it places us between the calendar and notifications.
            this._hbox = dm._messageList.get_parent();

            // Vertical rule — matches Adwaita's calendar/notification separator colour
            this._vSep = new St.Widget({
                style: 'width: 1px; background-color: rgba(127,127,127,0.22); margin: 0 2px;',
            });

            this._hbox.insert_child_below(this._vSep,        dm._messageList);
            this._hbox.insert_child_below(this._reminderBox, this._vSep);

            // Refresh countdown labels every time the panel opens
            this._menuOpenId = dm.menu.connect('open-state-changed', (_, open) => {
                if (open) this._refresh();
            });

            // Fire system notifications every 30 s
            this._interval = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, 30, () => this._checkDue()
            );
        } catch (e) {
            console.error('[Reminders] enable:', e);
        }
    }

    disable() {
        if (this._interval) {
            GLib.Source.remove(this._interval);
            this._interval = null;
        }

        const dm = Main.panel.statusArea.dateMenu;
        if (this._menuOpenId) {
            dm.menu.disconnect(this._menuOpenId);
            this._menuOpenId = null;
        }

        // Remove our widgets from the hbox cleanly
        if (this._hbox) {
            if (this._reminderBox) this._hbox.remove_child(this._reminderBox);
            if (this._vSep)        this._hbox.remove_child(this._vSep);
        }
        this._reminderBox?.destroy();
        this._vSep?.destroy();
        this._reminderBox = this._vSep = this._hbox = null;
        this._tasks = [];
    }
}