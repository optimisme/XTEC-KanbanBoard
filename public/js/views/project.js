// Project page with its tabs: groups, shared tasks, progress matrix,
// students and (administrators only) settings.
import { api } from '../api.js';
import { followProjects } from '../realtime.js';
import {
  append, clear, confirmDialog, field, groupLabel, h, icon, modal, plainInput, promptDialog, readableTextColor, run, showError,
  STATUS_LABELS, tagChip, tagChips,
  STATUSES, statusBadge, toast,
} from '../ui.js';
import { emailSuggestions } from '../people.js';
import { academicYearSelect, openProjectForm } from './projects.js';
import { openDefinition, openImport, openTaskEditor } from './taskEditor.js';
import { liveRanking, renderStudentRanking } from './ranking.js';
import { openTaskModal } from './taskModal.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function renderProject(view, [projectId, tabParam], ctx) {
  const project = await api.get(`/api/projects/${projectId}`);
  const isAdmin = project.access === 'admin';
  const writable = project.status === 'active';

  // Students work only on their group's board; the project page is for staff.
  if (!project.can_manage) {
    // ... except for the badges page, when the project shows it to them.
    if (tabParam === 'ranking' && project.ranking_visible) return renderStudentRanking(view, project);
    window.location.replace(`#/groups/${project.my_group_id}`);
    return;
  }

  // The progress matrix comes first and is what opens by default.
  const tabs = [
    ['matrix', 'Matriu de progrés'], ['ranking', 'Insígnies'], ['description', 'Descripció'], ['groups', 'Grups'],
    ['tasks', 'Tasques'], ['students', 'Alumnat'], ['settings', 'Configuració'],
  ];
  const tab = tabs.some(([key]) => key === tabParam) ? tabParam : 'matrix';
  const content = h('div', {});
  const reload = () => ctx.rerender();
  // "@xtec.cat, @iesesteveterradas.cat": the accounts the sign-in accepts.
  const domainsText = ctx.emailDomains.map((domain) => `@${domain}`).join(', ');

  append(view, 
    h('div', { class: 'page-header' },
      h('div', { class: 'titles' },
        h('div', { class: 'breadcrumb' }, h('a', { href: '#/' }, ctx.user.role === 'student' ? 'Els meus projectes' : 'Projectes')),
        h('h1', {}, project.name),
        h('div', { class: 'meta', style: { 'margin-top': '6px' } },
          h('span', {}, `Curs ${project.academic_year}`),
          h('span', {}, plural(project.task_count, 'tasca', 'tasques')),
          project.teachers.length ? h('span', {}, `Professorat: ${project.teachers.map((t) => t.name).join(', ')}`) : null)),
      h('div', { class: 'actions' },
        project.hidden ? h('span', { class: 'tag hidden-tag' }, 'Ocult als estudiants') : null,
        project.status === 'archived' ? h('span', { class: 'tag' }, 'Arxivat · només lectura') : null)),
    h('nav', { class: 'tabs', 'aria-label': 'Seccions del projecte' }, tabs.map(([key, label]) =>
      h('a', { href: `#/projects/${project.id}/${key}`, 'aria-current': key === tab ? 'page' : null }, label))),
    content
  );

  const renderers = { ranking: async () => { append(content, await liveRanking(project.id)); }, description: descriptionTab, groups: groupsTab, tasks: tasksTab, matrix: matrixTab, students: studentsTab, settings: settingsTab };
  await renderers[tab]();

  // ---- Description -------------------------------------------------------------

  function descriptionTab() {
    append(content,
      project.description_html
        ? h('div', { class: 'card markdown', html: project.description_html })
        : h('div', { class: 'empty' }, 'Aquest projecte encara no té descripció.'),
      project.can_manage && writable
        ? h('div', { class: 'card-actions' },
            h('button', { class: 'btn', type: 'button', onClick: () => openProjectForm({ project, onSaved: reload }).catch(showError) },
              project.description_html ? 'Edita la descripció' : 'Afegeix una descripció'))
        : null);
  }

  // ---- Groups ----------------------------------------------------------------

  // Group members are added by institutional email. An email without an
  // account yet asks for the student's name and creates the account on save.
  function openGroupForm(group) {
    const members = (group ? group.students : []).map((s) => ({ email: s.email, name: s.name, isNew: false }));
    const listEl = h('ul', { class: 'member-list' });
    const email = plainInput({ placeholder: 'Nom o correu', 'aria-label': "Nom o correu de l'alumne" });
    const name = h('input', { type: 'text', maxlength: '200', placeholder: 'Nom i cognoms', autocomplete: 'off' });
    const nameField = h('div', { class: 'field', hidden: true },
      h('label', {}, "Aquest correu encara no té compte. Indica el nom de l'alumne per crear-lo:"), name);
    const message = h('div', { class: 'notice error', role: 'alert', hidden: true });
    const add = h('button', { class: 'btn', type: 'button' }, 'Afegeix');
    const groupName = h('input', { type: 'text', maxlength: '40', autocomplete: 'off', value: group && group.name ? group.name : '' });
    const save = h('button', { class: 'btn primary', type: 'button' }, group ? 'Desa' : 'Crea el grup');
    let pendingEmail = null; // email waiting for a name

    const fail = (text) => { message.textContent = text; message.hidden = false; };
    const reset = () => { pendingEmail = null; nameField.hidden = true; name.value = ''; email.value = ''; message.hidden = true; email.focus(); };

    function drawMembers() {
      append(clear(listEl), members.length === 0
        ? h('li', { class: 'muted' }, 'Encara no hi ha ningú al grup.')
        : members.map((member, index) => {
            const remove = h('button', { class: 'btn ghost small', type: 'button', 'aria-label': `Treu ${member.name}` }, 'Treu');
            remove.addEventListener('click', () => { members.splice(index, 1); drawMembers(); });
            return h('li', {},
              h('div', {}, h('strong', {}, member.name), member.isNew ? h('span', { class: 'tag' }, 'Compte nou') : null,
                h('div', { class: 'muted' }, member.email)),
              remove);
          }));
    }

    async function addMember() {
      message.hidden = true;
      const value = email.value.trim().toLowerCase();
      if (!value) return email.focus();
      if (members.some((m) => m.email === value)) return fail('Aquesta persona ja és a la llista.');

      // Second step for an unknown email: the name has just been typed.
      if (pendingEmail === value) {
        if (!name.value.trim()) return name.focus();
        members.push({ email: value, name: name.value.trim(), isNew: true });
        drawMembers();
        return reset();
      }
      return run(add, async () => {
        const found = await api.post('/api/students/lookup', { email: value });
        if (found.found && found.problem) return fail(found.problem);
        if (found.found) {
          members.push({ email: value, name: found.name, isNew: false });
          drawMembers();
          return reset();
        }
        pendingEmail = value;
        nameField.hidden = false;
        return name.focus();
      });
    }

    add.addEventListener('click', addMember);
    for (const input of [email, name]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); addMember(); }
      });
    }
    email.addEventListener('input', () => {
      if (pendingEmail && email.value.trim().toLowerCase() !== pendingEmail) { pendingEmail = null; nameField.hidden = true; }
    });

    save.addEventListener('click', () => {
      if (members.length === 0) return fail('El grup ha de tenir almenys una persona.');
      return run(save, async () => {
        const body = { name: groupName.value, students: members.map((m) => ({ email: m.email, name: m.name })) };
        if (group) await api.put(`/api/groups/${group.id}/students`, body);
        else await api.post(`/api/projects/${project.id}/groups`, body);
        dialog.close();
        reload();
      });
    });

    const body = h('div', {},
      h('p', { class: 'muted' }, group
        ? "Si treus una persona del grup, les seves tasques queden sense responsable; l'historial es conserva."
        : `El grup nou serà el Grup ${project.groups.length ? Math.max(...project.groups.map((g) => g.group_number)) + 1 : 0} i rebrà totes les tasques del projecte com a pendents.`),
      field('Nom del grup (opcional)', groupName, 'Un text curt que es mostra al costat del número, per exemple «Grup 2: Els Pingüins».'),
      h('div', { class: 'field' }, h('label', {}, 'Alumnat del grup'), listEl),
      h('div', { class: 'field' },
        h('label', {}, `Afegeix una persona amb ${domainsText}`),
        h('div', { class: 'inline-form' }, email, add),
        emailSuggestions(email, 'students', {
          exclude: () => members.map((m) => m.email),
          onPick: (person) => {
            members.push({ email: person.email, name: person.name, isNew: false });
            drawMembers();
            reset();
          },
        })),
      nameField,
      message);
    const dialog = modal({ title: group ? groupLabel(group.group_number, group.name) : 'Nou grup', body, footer: [save] });
    drawMembers();
    email.focus();
  }

  function groupsTab() {
    const cards = project.groups.map((group) => {
      const total = STATUSES.reduce((sum, s) => sum + group.progress[s], 0);
      const remove = h('button', { class: 'btn small danger', type: 'button' }, 'Elimina');
      remove.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: `Elimina el ${groupLabel(group.group_number, group.name)}`,
          message: 'Només es poden eliminar grups sense cap activitat. Aquesta acció no es pot desfer.',
          confirmLabel: 'Elimina', danger: true,
        });
        if (ok) await run(remove, async () => { await api.del(`/api/groups/${group.id}`); reload(); });
      });

      // One full-width row per group: who and where, progress, actions.
      return h('div', { class: 'card group-row' },
        h('div', { class: 'group-info' },
          h('div', { class: 'card-title' },
            h('h2', {}, groupLabel(group.group_number, group.name)),
            project.my_group_id === group.id ? h('span', { class: 'tag' }, 'El meu grup') : null),
          h('div', { class: 'muted' }, group.students.map((s) => s.name).join(', ') || 'Sense alumnat'),
          h('div', { class: 'meta' },
            group.github_url
              ? h('a', { href: group.github_url, target: '_blank', rel: 'noopener noreferrer' }, group.github_url.replace('https://github.com/', 'github.com/'))
              : h('span', {}, 'Sense repositori de GitHub'),
            group.web_url
              ? h('a', { href: group.web_url, target: '_blank', rel: 'noopener noreferrer' }, group.web_url.replace(/^https?:\/\//, '').replace(/\/$/, ''))
              : null)),
        h('div', { class: 'group-progress' }, total > 0
          ? [
              h('div', { class: 'progress', role: 'img', 'aria-label': STATUSES.map((s) => `${STATUS_LABELS[s]}: ${group.progress[s]}`).join(', ') },
                STATUSES.map((s) => h('span', { class: s, style: { width: `${(group.progress[s] / total) * 100}%` } }))),
              h('div', { class: 'meta' }, STATUSES.filter((s) => group.progress[s] > 0).map((s) => h('span', {}, `${STATUS_LABELS[s]}: ${group.progress[s]}`))),
            ]
          : h('span', { class: 'muted' }, 'Sense tasques')),
        h('div', { class: 'card-actions' },
          h('a', { class: 'btn small primary', href: `#/groups/${group.id}` }, 'Obre el tauler'),
          project.can_manage && writable ? h('button', { class: 'btn small', type: 'button', onClick: () => openGroupForm(group) }, 'Edita el grup') : null,
          project.can_manage && writable ? remove : null));
    });

    append(content, 
      project.can_manage && writable
        ? h('div', { class: 'toolbar end' }, h('button', { class: 'btn primary', type: 'button', onClick: () => openGroupForm(null) }, 'Nou grup'))
        : null,
      cards.length ? h('div', { class: 'group-list' }, cards) : h('div', { class: 'empty' }, 'Aquest projecte encara no té grups.')
    );
  }

  // ---- Shared tasks -----------------------------------------------------------

  async function tasksTab() {
    let tasks = await api.get(`/api/projects/${project.id}/tasks`);
    const listEl = h('ol', { class: 'task-list' });
    const toolbar = h('div', { class: 'toolbar' });

    const refresh = async () => {
      tasks = await api.get(`/api/projects/${project.id}/tasks`);
      draw();
    };

    async function moveTask(index, delta, button) {
      const order = tasks.map((t) => t.id);
      [order[index], order[index + delta]] = [order[index + delta], order[index]];
      await run(button, async () => {
        tasks = await api.put(`/api/projects/${project.id}/tasks/order`, { task_ids: order });
        draw();
      });
    }

    // Dragging a task by its handle to another place in the list. It is done
    // with pointer events, not the browser's own drag and drop, so the same
    // code serves a mouse, a pen and a finger on a touch screen.
    // While a task is carried, the others slide out of its way and a blue
    // slot shows where it would land.
    const SIDEWAYS = 0.35; // How much of the sideways movement the row follows.
    const SIDEWAYS_MAX = 36;
    const GLIDE_MS = 170;
    let drag = null;

    // Where everything goes for the current pointer position. Positions are
    // measured inside the list when the drag starts, so they stay right
    // while the page scrolls under the pointer.
    function trackDrag() {
      const dy = drag.clientY + window.scrollY - drag.startY;
      const dx = Math.max(-SIDEWAYS_MAX, Math.min(SIDEWAYS_MAX, (drag.clientX - drag.startX) * SIDEWAYS));
      drag.row.style.setProperty('transform', `translate(${dx}px, ${dy}px)`);

      // A row above gives way when the carried one passes its middle going
      // up, and a row below when it is passed going down.
      const centre = drag.boxes[drag.from].middle + dy;
      let to = drag.from;
      let slotTop = drag.boxes[drag.from].top;
      drag.rows.forEach((row, index) => {
        if (index === drag.from) return;
        const box = drag.boxes[index];
        let shift = 0;
        if (index < drag.from && centre < box.middle) {
          shift = drag.step;
          to -= 1;
          slotTop -= box.height + drag.gap;
        } else if (index > drag.from && centre > box.middle) {
          shift = -drag.step;
          to += 1;
          slotTop += box.height + drag.gap;
        }
        if (box.shift !== shift) {
          box.shift = shift;
          row.style.setProperty('transform', `translateY(${shift}px)`);
        }
      });
      drag.to = to;
      drag.slotTop = slotTop;
      drag.slot.style.setProperty('top', `${slotTop}px`);
    }

    // Near the top or bottom edge of the window the page scrolls by itself.
    function autoScroll() {
      if (!drag || drag.ending) return;
      const edge = 70;
      let step = 0;
      if (drag.clientY < edge) step = -Math.ceil((edge - drag.clientY) / 6);
      else if (drag.clientY > window.innerHeight - edge) step = Math.ceil((drag.clientY - (window.innerHeight - edge)) / 6);
      if (step) {
        window.scrollBy(0, step);
        trackDrag();
      }
      drag.frame = requestAnimationFrame(autoScroll);
    }

    function startDrag(event, index, handle) {
      if (drag || (event.pointerType === 'mouse' && event.button !== 0)) return;
      event.preventDefault();
      const rows = [...listEl.querySelectorAll('.task-row')];
      const row = rows[index];
      const boxes = rows.map((el) => ({ top: el.offsetTop, height: el.offsetHeight, middle: el.offsetTop + el.offsetHeight / 2, shift: 0 }));
      const gap = rows.length > 1 ? boxes[1].top - (boxes[0].top + boxes[0].height) : 0;
      // The blue slot: the place the carried task would take.
      const slot = h('li', { class: 'drop-slot', 'aria-hidden': 'true' });
      slot.style.setProperty('top', `${boxes[index].top}px`);
      slot.style.setProperty('height', `${boxes[index].height}px`);
      listEl.append(slot);
      drag = {
        from: index,
        to: index,
        row,
        rows,
        boxes,
        gap,
        step: boxes[index].height + gap,
        slot,
        slotTop: boxes[index].top,
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        startX: event.clientX,
        startY: event.clientY + window.scrollY,
      };
      // From now on every move of this pointer comes to the handle, wherever
      // the pointer is on the page.
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser no longer knows: the drag simply never moves.
      }
      listEl.classList.add('sorting');
      row.classList.add('dragging');
      document.body.classList.add('reordering');
      drag.frame = requestAnimationFrame(autoScroll);
    }

    function moveDrag(event) {
      if (!drag || drag.ending || event.pointerId !== drag.pointerId) return;
      drag.clientX = event.clientX;
      drag.clientY = event.clientY;
      trackDrag();
    }

    // `commit` is false when the drag is cancelled (Escape, or the system
    // taking the pointer away). Either way the carried task glides into the
    // slot (its new place, or the one it came from) before the list is redrawn.
    async function endDrag(event, commit) {
      if (!drag || drag.ending || (event && event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
      const ended = drag;
      ended.ending = true;
      cancelAnimationFrame(ended.frame);
      const { from, row, rows, boxes } = ended;
      const to = commit ? ended.to : from;
      if (!commit) {
        rows.forEach((el, index) => index !== from && el.style.setProperty('transform', 'translateY(0px)'));
        ended.slot.style.setProperty('top', `${boxes[from].top}px`);
      }
      row.classList.add('settling');
      row.style.setProperty('transform', `translate(0px, ${(commit ? ended.slotTop : boxes[from].top) - boxes[from].top}px)`);
      await new Promise((resolve) => { setTimeout(resolve, GLIDE_MS); });

      drag = null;
      document.body.classList.remove('reordering');
      listEl.classList.remove('sorting');
      if (to === from) {
        draw();
        return;
      }
      const order = tasks.map((t) => t.id);
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved);
      // Shown at once in its new place; the server's answer confirms it.
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const before = tasks;
      tasks = order.map((id) => byId.get(id));
      draw();
      try {
        tasks = await api.put(`/api/projects/${project.id}/tasks/order`, { task_ids: order });
      } catch (err) {
        tasks = before;
        showError(err);
      }
      draw();
    }
    const cancelOnEscape = (event) => {
      // The listener goes away with the list it belongs to.
      if (!listEl.isConnected) document.removeEventListener('keydown', cancelOnEscape);
      else if (event.key === 'Escape' && drag) endDrag(null, false);
    };
    document.addEventListener('keydown', cancelOnEscape);

    function draw() {
      append(clear(toolbar), 
        // The hint stays on the left; the actions sit at the right end of the row.
        h('span', { class: 'muted grow' }, project.can_manage
          ? "L'ordre de la llista és l'ordre global de les tasques per a tots els grups. Arrossega el cercle o fes servir les fletxes per canviar-lo."
          : "Les tasques es mostren en l'ordre global definit pel professorat."),
        project.can_manage && writable
          ? h('button', { class: 'btn primary', type: 'button', onClick: () => openTaskEditor({ projectId: project.id, onSaved: refresh }).catch(showError) }, 'Nova tasca')
          : null,
        // The import is offered only while the project has no tasks at all.
        project.can_manage && writable && tasks.length === 0
          ? h('button', { class: 'btn', type: 'button', onClick: () => openImport({ project, onDone: refresh }) }, 'Importa des de Markdown')
          : null
      );

      append(clear(listEl), tasks.map((task, index) => {
        const up = h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': `Puja «${task.title}»`, disabled: index === 0 }, icon('up'));
        const down = h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': `Baixa «${task.title}»`, disabled: index === tasks.length - 1 }, icon('down'));
        up.addEventListener('click', () => moveTask(index, -1, up));
        down.addEventListener('click', () => moveTask(index, 1, down));
        // Between the arrows, the handle the task is dragged by.
        const handle = h('span', { class: 'drag-handle', title: 'Arrossega per canviar la posició', 'aria-hidden': 'true' });
        handle.addEventListener('pointerdown', (event) => startDrag(event, index, handle));
        handle.addEventListener('pointermove', moveDrag);
        handle.addEventListener('pointerup', (event) => endDrag(event, true));
        handle.addEventListener('pointercancel', (event) => endDrag(event, false));
        const remove = h('button', { class: 'btn ghost small danger', type: 'button' }, 'Elimina');
        remove.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Elimina la tasca',
            message: `«${task.title}» desapareixerà dels taulers de tots els grups. L'historial es conserva a la base de dades.`,
            confirmLabel: 'Elimina', danger: true,
          });
          if (ok) await run(remove, async () => { await api.del(`/api/tasks/${task.id}`); await refresh(); });
        });

        return h('li', { class: 'task-row' },
          project.can_manage && writable ? h('div', { class: 'order-controls' }, up, handle, down) : null,
          h('span', { class: 'position', 'aria-label': `Posició ${index + 1}` }, String(index + 1)),
          h('div', { class: 'body' },
            h('button', {
              class: 'task-title', type: 'button',
              // Managers go straight to the editor; everyone else (and archived
              // projects) gets the read-only view.
              onClick: () => (project.can_manage && writable
                ? openTaskEditor({ projectId: project.id, taskId: task.id, onSaved: refresh })
                : openDefinition(task.id, { canManage: project.can_manage, writable, onChanged: refresh })
              ).catch(showError),
            }, task.title),
            tagChips(task.tags)),
          project.can_manage && writable ? h('div', { class: 'row-actions' }, remove) : null);
      }));
      if (tasks.length === 0) append(listEl, h('li', { class: 'empty' }, 'Aquest projecte encara no té tasques.'));
    }

    append(content, toolbar, listEl);
    draw();
  }

  // ---- Progress matrix ----------------------------------------------------------

  async function matrixTab() {
    const holder = h('div', {});
    const filter = h('select', { id: 'matrix-tag' },
      h('option', { value: '' }, 'Totes les etiquetes'),
      project.tags.map((tag) => h('option', { value: String(tag.id) }, tag.name)));

    async function draw() {
      const matrix = await api.get(`/api/projects/${project.id}/matrix${filter.value ? `?tag_id=${filter.value}` : ''}`);
      if (matrix.groups.length === 0 || matrix.tasks.length === 0) {
        append(clear(holder), h('div', { class: 'empty' }, 'No hi ha dades per mostrar: calen grups i tasques.'));
        return;
      }
      // A redraw (real time) keeps a wide matrix scrolled where it was.
      const previous = holder.querySelector('.matrix-wrap');
      const scrolled = previous ? [previous.scrollLeft, previous.scrollTop] : null;
      append(clear(holder), 
        h('div', { class: 'matrix-wrap' },
          h('table', { class: 'matrix' },
            h('thead', {}, h('tr', {},
              h('th', { class: 'group-head', scope: 'col' }, 'Grup'),
              matrix.tasks.map((t) => h('th', { scope: 'col', title: t.title },
                h('div', { class: 'col-title' }, t.title),
                h('span', { class: 'col-num' }, String(t.position)))))),
            h('tbody', {}, matrix.groups.map((group) => h('tr', {},
              h('th', { class: 'group-head', scope: 'row' },
                h('a', { href: `#/groups/${group.id}` }, h('strong', {}, groupLabel(group.group_number, group.name))),
                h('small', {}, group.students.map((s) => s.name).join(', '))),
              matrix.tasks.map((t) => {
                const cell = group.cells[t.id];
                const label = `${groupLabel(group.group_number, group.name)} · ${t.title}: ${STATUS_LABELS[cell.status]}${cell.responsible_name ? ` (${cell.responsible_name})` : ''}`;
                return h('td', {},
                  h('button', {
                    class: `cell ${cell.status}`, type: 'button', title: label, 'aria-label': label,
                    onClick: () => openTaskModal(cell.group_task_id, { readOnly: true }).catch(showError),
                  }, icon(cell.status)));
              }))))))
      );
      if (scrolled) [holder.firstChild.scrollLeft, holder.firstChild.scrollTop] = scrolled;
      stick();
    }

    filter.addEventListener('change', () => draw().catch(showError));
    // The filter at the left of the row and, at its right end, what the
    // colours of the cells mean.
    append(content,
      h('div', { class: 'toolbar' },
        h('label', { for: 'matrix-tag' }, 'Filtra per etiqueta'), filter,
        h('div', { class: 'legend' }, STATUSES.map(statusBadge))),
      holder);
    // Only the page scrolls up and down. Once the header of the matrix has
    // scrolled out, its bottom strip (the task numbers) is kept in view just
    // under the top bar, down to the last row.
    function stick() {
      const table = holder.querySelector('.matrix');
      if (!table) return;
      const head = table.tHead;
      const number = head.querySelector('.col-num');
      const strip = head.getBoundingClientRect().height - (number.offsetTop - 6);
      const bar = document.querySelector('.topbar');
      const under = bar ? bar.getBoundingClientRect().bottom : 0;
      const hidden = under - (table.getBoundingClientRect().top + head.offsetHeight - strip);
      const lastRow = table.tBodies[0].lastElementChild;
      const most = table.offsetHeight - head.offsetHeight - (lastRow ? lastRow.offsetHeight : 0);
      const shift = Math.max(0, Math.min(hidden, most));
      table.style.setProperty('--stick', `${Math.round(shift)}px`);
      table.classList.toggle('stuck', shift > 0);
    }
    let frame = null;
    const onScroll = () => {
      if (!holder.isConnected) {
        // The listeners go away with the matrix they belong to.
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
        return;
      }
      if (frame === null) frame = requestAnimationFrame(() => { frame = null; stick(); });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    await draw();
    // Real time: the cells follow what the groups do on their boards.
    followProjects(holder, [project.id], draw);
  }

  // ---- Students -------------------------------------------------------------------

  function studentsTab() {
    const rows = project.groups.flatMap((group) => group.students.map((student) =>
      h('tr', {},
        h('td', {}, student.name),
        h('td', { class: 'muted' }, student.email),
        h('td', {}, h('a', { href: `#/groups/${group.id}` }, groupLabel(group.group_number, group.name))),
        h('td', { class: 'actions' }, h('a', { class: 'btn small', href: `#/projects/${project.id}/students/${student.id}` }, 'Veu l\'activitat')))));
    append(content, rows.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Alumne/a'), h('th', {}, 'Correu'), h('th', {}, 'Grup'), h('th', {}, ''))),
          h('tbody', {}, rows)))
      : h('div', { class: 'empty' }, 'Aquest projecte encara no té alumnat assignat.'));
  }

  // ---- Settings (administrators) -----------------------------------------------------

  async function settingsTab() {
    // Removing a teacher saves at once.
    async function removeTeacher(teacher, button) {
      const ok = await confirmDialog({
        title: 'Elimina del projecte',
        message: `${teacher.name} deixarà de tenir accés a aquest projecte. El seu compte es conserva.`,
        confirmLabel: 'Elimina', danger: true,
      });
      if (!ok) return;
      await run(button, async () => {
        await api.del(`/api/projects/${project.id}/teachers/${teacher.id}`);
        toast(`${teacher.name} ja no és professor/a del projecte.`);
        reload();
      });
    }

    async function addTeacherByEmail(value) {
      const found = await api.post('/api/teachers/lookup', { email: value });
      if (found.found && found.problem) throw new Error(found.problem);
      let name;
      if (!found.found) {
        name = await promptDialog({
          title: 'Compte nou de professorat',
          label: 'Nom i cognoms',
          hint: `${value} encara no té compte. Es crearà amb aquest nom i podrà entrar amb el compte institucional.`,
          confirmLabel: 'Crea i afegeix',
        });
        if (name === null) return;
      }
      await api.post(`/api/projects/${project.id}/teachers`, { email: value, name });
      toast('Professorat afegit al projecte.');
      reload();
    }

    function addTeacherForm() {
      const email = plainInput({ required: true, placeholder: 'Nom o correu', 'aria-label': 'Nom o correu del professor o professora' });
      const add = h('button', { class: 'btn', type: 'submit' }, 'Afegeix');
      return h('form', {
        class: 'field', style: { 'margin-top': '14px' },
        onSubmit: (event) => {
          event.preventDefault();
          run(add, () => addTeacherByEmail(email.value.trim().toLowerCase()));
        },
      },
        h('label', {}, `Afegeix professorat amb ${domainsText}`),
        h('div', { class: 'inline-form' }, email, add),
        // Choosing a suggestion adds that teacher straight away.
        emailSuggestions(email, 'teachers', {
          exclude: () => project.teachers.map((t) => t.email),
          onPick: (person) => run(add, () => addTeacherByEmail(person.email)),
        }));
    }

    // Tags of the project: rename, recolor, delete, add.
    async function tagsCard() {
      let tags = await api.get(`/api/projects/${project.id}/tags`);
      const listEl = h('ul', { class: 'member-list' });
      const refresh = async () => { tags = await api.get(`/api/projects/${project.id}/tags`); draw(); };

      function draw() {
        append(clear(listEl), tags.length === 0
          ? h('li', { class: 'muted' }, 'Aquest projecte encara no té etiquetes.')
          : tags.map((tag) => {
              const name = h('input', { type: 'text', maxlength: '40', value: tag.name, 'aria-label': `Nom de l'etiqueta ${tag.name}`, disabled: !writable });
              const color = h('input', { type: 'color', value: tag.color, 'aria-label': `Color de l'etiqueta ${tag.name}`, disabled: !writable });
              const preview = h('span', {});
              const drawPreview = () => append(clear(preview),
                tagChip({ name: name.value || tag.name, color: color.value, text_color: readableTextColor(color.value) }));
              const save = () => run(null, async () => {
                if (!name.value.trim()) { name.value = tag.name; return; }
                if (name.value.trim() === tag.name && color.value === tag.color) return;
                await api.put(`/api/tags/${tag.id}`, { name: name.value, color: color.value });
                await refresh();
              });
              name.addEventListener('input', drawPreview);
              color.addEventListener('input', drawPreview);
              name.addEventListener('change', save);
              color.addEventListener('change', save);
              const remove = h('button', { class: 'btn ghost small danger', type: 'button', disabled: !writable }, 'Elimina');
              remove.addEventListener('click', async () => {
                const ok = await confirmDialog({
                  title: "Elimina l'etiqueta", message: `«${tag.name}» es traurà de totes les tasques que la tenen.`,
                  confirmLabel: 'Elimina', danger: true,
                });
                if (ok) await run(remove, async () => { await api.del(`/api/tags/${tag.id}`); await refresh(); });
              });
              drawPreview();
              return h('li', {}, h('div', { class: 'tag-row' }, color, name, preview), remove);
            }));
      }

      const newName = plainInput({ maxlength: '40', placeholder: 'Etiqueta nova', 'aria-label': 'Etiqueta nova' });
      const add = h('button', { class: 'btn', type: 'submit' }, 'Afegeix');
      const form = h('form', {
        class: 'inline-form', style: { 'margin-top': '12px' },
        onSubmit: (event) => {
          event.preventDefault();
          run(add, async () => {
            await api.post(`/api/projects/${project.id}/tags`, { name: newName.value });
            newName.value = '';
            await refresh();
          });
        },
      }, newName, add);

      draw();
      return h('div', { class: 'card' },
        h('h2', {}, 'Etiquetes'),
        h('p', { class: 'muted' }, "Les etiquetes classifiquen i acoloreixen les tasques d'aquest projecte. També es poden crear directament en editar una tasca."),
        listEl,
        writable ? form : null);
    }

    const archive = h('button', { class: 'btn', type: 'button' }, writable ? 'Arxiva el projecte' : 'Reactiva el projecte');
    archive.addEventListener('click', async () => {
      const ok = await confirmDialog(writable
        ? { title: 'Arxiva el projecte', message: 'El projecte quedarà disponible per a consulta, però ningú no el podrà modificar.', confirmLabel: 'Arxiva' }
        : { title: 'Reactiva el projecte', message: 'El projecte tornarà a ser editable.', confirmLabel: 'Reactiva' });
      if (ok) await run(archive, async () => { await api.post(`/api/projects/${project.id}/${writable ? 'archive' : 'unarchive'}`); reload(); });
    });

    // Administrators only, and only once the project is archived.
    const erase = h('button', { class: 'btn danger', type: 'button' }, 'Esborra el projecte');
    erase.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Esborra el projecte',
        message: `Vols esborrar definitivament «${project.name}»? S'esborraran les tasques, els grups, el progrés, els comentaris i l'historial. No es pot desfer. Els comptes d'usuari es conserven.`,
        confirmLabel: 'Esborra definitivament',
        danger: true,
      });
      if (!ok) return;
      await run(erase, async () => {
        await api.del(`/api/projects/${project.id}`);
        toast('Projecte esborrat.');
        window.location.hash = '#/';
      });
    });

    function openDuplicate() {
      const [start] = project.academic_year.split('-').map(Number);
      const name = h('input', { type: 'text', maxlength: '200', required: true, value: project.name });
      // The copy is proposed for the year after the original.
      const year = academicYearSelect(`${start + 1}-${start + 2}`);
      const description = h('textarea', { rows: '3' });
      description.value = project.description || '';
      const save = h('button', { class: 'btn primary', type: 'submit' }, 'Duplica');
      const form = h('form', {
        onSubmit: (event) => {
          event.preventDefault();
          run(save, async () => {
            const copy = await api.post(`/api/projects/${project.id}/duplicate`, {
              name: name.value, academic_year: year.value, description: description.value,
            });
            dialog.close();
            toast('Projecte duplicat.');
            window.location.hash = `#/projects/${copy.id}/settings`;
          });
        },
      },
        h('div', { class: 'notice' }, 'Es copien les etiquetes, les tasques compartides i el seu ordre. No es copien el professorat, els grups, l\'alumnat ni cap progrés.'),
        field('Nom del projecte nou', name),
        field('Curs acadèmic', year),
        field('Descripció', description),
        h('div', { class: 'card-actions' }, save));
      const dialog = modal({ title: 'Duplica el projecte', body: form });
    }

    append(content, 
      h('div', { class: 'card' },
        h('h2', {}, 'Dades del projecte'),
        h('div', { class: 'card-actions' },
          h('button', { class: 'btn', type: 'button', disabled: !writable, onClick: () => openProjectForm({ project, onSaved: reload }).catch(showError) }, 'Edita el projecte'))),
      h('div', { class: 'card' },
        h('h2', {}, 'Professorat assignat'),
        h('p', { class: 'muted' }, 'El professorat assignat pot gestionar totes les tasques i tots els grups del projecte.'),
        h('ul', { class: 'member-list' }, project.teachers.length === 0
          ? h('li', { class: 'muted' }, 'Aquest projecte encara no té professorat assignat.')
          : project.teachers.map((teacher) => {
              const remove = h('button', { class: 'btn ghost small danger', type: 'button', 'aria-label': `Elimina ${teacher.name}` }, 'Elimina');
              remove.addEventListener('click', () => removeTeacher(teacher, remove));
              // A teacher cannot remove themself (an administrator or a colleague can).
              const own = !isAdmin && teacher.id === ctx.user.id;
              return h('li', {},
                h('div', {}, h('strong', {}, teacher.name), h('div', { class: 'muted' }, teacher.email)),
                writable && !own ? remove : null);
            })),
        writable ? addTeacherForm() : null),
      await tagsCard(),
      h('div', { class: 'card' },
        h('h2', {}, 'Cicle de vida'),
        h('p', { class: 'muted' }, 'Duplica el projecte per a un curs nou o arxiva\'l quan acabi.'),
        h('div', { class: 'card-actions' },
          h('button', { class: 'btn', type: 'button', onClick: openDuplicate }, 'Duplica per a un altre curs'),
          archive,
          isAdmin && !writable ? erase : null),
        isAdmin && writable
          ? h('p', { class: 'muted', style: { 'margin-top': '10px' } }, "Per esborrar un projecte, primer cal arxivar-lo.")
          : null)
    );
  }
}
