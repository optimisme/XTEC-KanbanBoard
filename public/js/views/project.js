// Project page with its tabs: groups, shared tasks, progress matrix,
// students and (administrators only) settings.
import { api } from '../api.js';
import {
  append, checkList, clear, confirmDialog, field, h, icon, modal, moduleChips, run, showError, STATUS_LABELS,
  STATUSES, statusBadge, toast,
} from '../ui.js';
import { openProjectForm } from './projects.js';
import { openDefinition, openImport, openTaskEditor } from './taskEditor.js';
import { openTaskModal } from './taskModal.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function renderProject(view, [projectId, tabParam], ctx) {
  const project = await api.get(`/api/projects/${projectId}`);
  const isAdmin = project.access === 'admin';
  const writable = project.status === 'active';

  const tabs = [['groups', 'Grups'], ['tasks', 'Tasques']];
  if (project.can_manage) tabs.push(['matrix', 'Matriu de progrés'], ['students', 'Alumnat']);
  if (project.can_manage) tabs.push(['settings', 'Configuració']);
  const tab = tabs.some(([key]) => key === tabParam) ? tabParam : 'groups';
  const content = h('div', {});
  const reload = () => ctx.rerender();

  append(view, 
    h('div', { class: 'page-header' },
      h('div', { class: 'titles' },
        h('div', { class: 'breadcrumb' }, h('a', { href: '#/' }, ctx.user.role === 'student' ? 'Els meus projectes' : 'Projectes')),
        h('h1', {}, project.name),
        h('div', { class: 'meta', style: { 'margin-top': '6px' } },
          h('span', {}, `Curs ${project.academic_year}`),
          h('span', {}, plural(project.task_count, 'tasca', 'tasques')),
          project.teachers.length ? h('span', {}, `Professorat: ${project.teachers.map((t) => t.name).join(', ')}`) : null)),
      project.status === 'archived' ? h('span', { class: 'tag' }, 'Arxivat · només lectura') : null),
    project.description_html ? h('div', { class: 'card markdown', style: { 'margin-bottom': '20px' }, html: project.description_html }) : null,
    h('nav', { class: 'tabs', 'aria-label': 'Seccions del projecte' }, tabs.map(([key, label]) =>
      h('a', { href: `#/projects/${project.id}/${key}`, 'aria-current': key === tab ? 'page' : null }, label))),
    content
  );

  const renderers = { groups: groupsTab, tasks: tasksTab, matrix: matrixTab, students: studentsTab, settings: settingsTab };
  await renderers[tab]();

  // ---- Groups ----------------------------------------------------------------

  // Group members are added by institutional email. An email without an
  // account yet asks for the student's name and creates the account on save.
  function openGroupForm(group) {
    const members = (group ? group.students : []).map((s) => ({ email: s.email, name: s.name, isNew: false }));
    const listEl = h('ul', { class: 'member-list' });
    const email = h('input', { type: 'email', placeholder: 'alumne@xtec.cat', autocomplete: 'off', 'aria-label': "Correu de l'alumne" });
    const name = h('input', { type: 'text', maxlength: '200', placeholder: 'Nom i cognoms', autocomplete: 'off' });
    const nameField = h('div', { class: 'field', hidden: true },
      h('label', {}, "Aquest correu encara no té compte. Indica el nom de l'alumne per crear-lo:"), name);
    const message = h('div', { class: 'notice error', role: 'alert', hidden: true });
    const add = h('button', { class: 'btn', type: 'button' }, 'Afegeix');
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
        const body = { students: members.map((m) => ({ email: m.email, name: m.name })) };
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
      h('div', { class: 'field' }, h('label', {}, 'Alumnat del grup'), listEl),
      h('div', { class: 'field' },
        h('label', {}, 'Afegeix una persona pel seu correu institucional'),
        h('div', { class: 'inline-form' }, email, add)),
      nameField,
      message);
    const dialog = modal({ title: group ? `Alumnat del Grup ${group.group_number}` : 'Nou grup', body, footer: [save] });
    drawMembers();
    email.focus();
  }

  function groupsTab() {
    const cards = project.groups.map((group) => {
      const total = STATUSES.reduce((sum, s) => sum + group.progress[s], 0);
      const remove = h('button', { class: 'btn small danger', type: 'button' }, 'Elimina');
      remove.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: `Elimina el Grup ${group.group_number}`,
          message: 'Només es poden eliminar grups sense cap activitat. Aquesta acció no es pot desfer.',
          confirmLabel: 'Elimina', danger: true,
        });
        if (ok) await run(remove, async () => { await api.del(`/api/groups/${group.id}`); reload(); });
      });

      return h('div', { class: 'card' },
        h('div', { class: 'card-title' },
          h('h2', {}, `Grup ${group.group_number}`),
          project.my_group_id === group.id ? h('span', { class: 'tag' }, 'El meu grup') : null),
        h('div', { class: 'muted' }, group.students.map((s) => s.name).join(', ') || 'Sense alumnat'),
        total > 0
          ? [
              h('div', { class: 'progress', role: 'img', 'aria-label': STATUSES.map((s) => `${STATUS_LABELS[s]}: ${group.progress[s]}`).join(', ') },
                STATUSES.map((s) => h('span', { class: s, style: { width: `${(group.progress[s] / total) * 100}%` } }))),
              h('div', { class: 'meta' }, STATUSES.filter((s) => group.progress[s] > 0).map((s) => h('span', {}, `${STATUS_LABELS[s]}: ${group.progress[s]}`))),
            ]
          : null,
        h('div', { class: 'meta', style: { 'margin-top': '8px' } },
          group.github_url
            ? h('a', { href: group.github_url, target: '_blank', rel: 'noopener noreferrer' }, group.github_url.replace('https://github.com/', 'github.com/'))
            : h('span', {}, 'Sense repositori de GitHub')),
        h('div', { class: 'card-actions' },
          h('a', { class: 'btn small primary', href: `#/groups/${group.id}` }, 'Obre el tauler'),
          project.can_manage && writable ? h('button', { class: 'btn small', type: 'button', onClick: () => openGroupForm(group) }, "Edita l'alumnat") : null,
          project.can_manage && writable ? remove : null));
    });

    append(content, 
      project.can_manage && writable
        ? h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'button', onClick: () => openGroupForm(null) }, 'Nou grup'))
        : null,
      cards.length ? h('div', { class: 'grid' }, cards) : h('div', { class: 'empty' }, 'Aquest projecte encara no té grups.')
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

    function draw() {
      append(clear(toolbar), 
        project.can_manage && writable
          ? h('button', { class: 'btn primary', type: 'button', onClick: () => openTaskEditor({ projectId: project.id, onSaved: refresh }).catch(showError) }, 'Nova tasca')
          : null,
        // The import is offered only while the project has no tasks at all.
        project.can_manage && writable && tasks.length === 0
          ? h('button', { class: 'btn', type: 'button', onClick: () => openImport({ project, onDone: refresh }) }, 'Importa des de Markdown')
          : null,
        h('span', { class: 'muted' }, project.can_manage
          ? "L'ordre de la llista és l'ordre global de les tasques per a tots els grups."
          : "Les tasques es mostren en l'ordre global definit pel professorat.")
      );

      append(clear(listEl), tasks.map((task, index) => {
        const up = h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': `Puja «${task.title}»`, disabled: index === 0 }, icon('up'));
        const down = h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': `Baixa «${task.title}»`, disabled: index === tasks.length - 1 }, icon('down'));
        up.addEventListener('click', () => moveTask(index, -1, up));
        down.addEventListener('click', () => moveTask(index, 1, down));
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
          h('span', { class: 'position', 'aria-label': `Posició ${index + 1}` }, String(index + 1)),
          h('div', { class: 'body' },
            h('button', {
              class: 'task-title', type: 'button',
              onClick: () => openDefinition(task.id, { canManage: project.can_manage, writable, onChanged: refresh }).catch(showError),
            }, task.title),
            moduleChips(task.modules)),
          project.can_manage && writable ? h('div', { class: 'row-actions' }, up, down, remove) : null);
      }));
      if (tasks.length === 0) append(listEl, h('li', { class: 'empty' }, 'Aquest projecte encara no té tasques.'));
    }

    append(content, toolbar, listEl);
    draw();
  }

  // ---- Progress matrix ----------------------------------------------------------

  async function matrixTab() {
    const holder = h('div', {});
    const filter = h('select', { id: 'matrix-module' },
      h('option', { value: '' }, 'Tots els mòduls'),
      project.modules.map((m) => h('option', { value: String(m.id) }, m.name)));

    async function draw() {
      const matrix = await api.get(`/api/projects/${project.id}/matrix${filter.value ? `?module_id=${filter.value}` : ''}`);
      if (matrix.groups.length === 0 || matrix.tasks.length === 0) {
        append(clear(holder), h('div', { class: 'empty' }, 'No hi ha dades per mostrar: calen grups i tasques.'));
        return;
      }
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
                h('a', { href: `#/groups/${group.id}` }, h('strong', {}, `Grup ${group.group_number}`)),
                h('small', {}, group.students.map((s) => s.name).join(', '))),
              matrix.tasks.map((t) => {
                const cell = group.cells[t.id];
                const label = `Grup ${group.group_number} · ${t.title}: ${STATUS_LABELS[cell.status]}${cell.responsible_name ? ` (${cell.responsible_name})` : ''}`;
                return h('td', {},
                  h('button', {
                    class: `cell ${cell.status}`, type: 'button', title: label, 'aria-label': label,
                    onClick: () => openTaskModal(cell.group_task_id, { onChange: () => draw().catch(showError) }).catch(showError),
                  }, icon(cell.status)));
              })))))),
        h('div', { class: 'legend' }, STATUSES.map(statusBadge))
      );
    }

    filter.addEventListener('change', () => draw().catch(showError));
    append(content, h('div', { class: 'toolbar' }, h('label', { for: 'matrix-module' }, 'Filtra per mòdul'), filter), holder);
    await draw();
  }

  // ---- Students -------------------------------------------------------------------

  function studentsTab() {
    const rows = project.groups.flatMap((group) => group.students.map((student) =>
      h('tr', {},
        h('td', {}, student.name),
        h('td', { class: 'muted' }, student.email),
        h('td', {}, h('a', { href: `#/groups/${group.id}` }, `Grup ${group.group_number}`)),
        h('td', { class: 'actions' }, h('a', { class: 'btn small', href: `#/projects/${project.id}/students/${student.id}` }, 'Veu l\'activitat')))));
    append(content, rows.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Alumne/a'), h('th', {}, 'Correu'), h('th', {}, 'Grup'), h('th', {}, ''))),
          h('tbody', {}, rows)))
      : h('div', { class: 'empty' }, 'Aquest projecte encara no té alumnat assignat.'));
  }

  // ---- Settings (administrators) -----------------------------------------------------

  async function settingsTab() {
    // Only administrators decide which teachers belong to a project.
    const teachers = isAdmin ? await api.get('/api/users?role=teacher&status=active') : [];
    const teacherList = checkList(
      teachers.map((t) => ({ id: t.id, label: t.name, detail: t.email })),
      project.teachers.map((t) => t.id),
      { emptyText: 'No hi ha professorat actiu. Assigna el rol a «Usuaris».' }
    );
    const saveTeachers = h('button', { class: 'btn primary', type: 'button', disabled: !writable }, 'Desa el professorat');
    saveTeachers.addEventListener('click', () => run(saveTeachers, async () => {
      await api.put(`/api/projects/${project.id}/teachers`, { teacher_ids: teacherList.values() });
      toast('Professorat actualitzat.');
      reload();
    }));

    // Teachers add a colleague by email; the colleague must already have a teacher account.
    function addTeacherForm() {
      const email = h('input', { type: 'email', required: true, placeholder: 'professor@xtec.cat', autocomplete: 'off', 'aria-label': 'Correu del professor o professora' });
      const add = h('button', { class: 'btn', type: 'submit' }, 'Afegeix');
      return h('form', {
        class: 'field', style: { 'margin-top': '14px' },
        onSubmit: (event) => {
          event.preventDefault();
          run(add, async () => {
            await api.post(`/api/projects/${project.id}/teachers`, { email: email.value });
            toast('Professorat afegit al projecte.');
            reload();
          });
        },
      },
        h('label', {}, 'Afegeix professorat pel seu correu institucional'),
        h('div', { class: 'inline-form' }, email, add),
        h('div', { class: 'hint' }, 'Ha de tenir ja un compte de professorat a l\'aplicació.'));
    }

    const archive = h('button', { class: 'btn', type: 'button' }, writable ? 'Arxiva el projecte' : 'Reactiva el projecte');
    archive.addEventListener('click', async () => {
      const ok = await confirmDialog(writable
        ? { title: 'Arxiva el projecte', message: 'El projecte quedarà disponible per a consulta, però ningú no el podrà modificar.', confirmLabel: 'Arxiva' }
        : { title: 'Reactiva el projecte', message: 'El projecte tornarà a ser editable.', confirmLabel: 'Reactiva' });
      if (ok) await run(archive, async () => { await api.post(`/api/projects/${project.id}/${writable ? 'archive' : 'unarchive'}`); reload(); });
    });

    function openDuplicate() {
      const [start] = project.academic_year.split('-').map(Number);
      const name = h('input', { type: 'text', maxlength: '200', required: true, value: project.name });
      const year = h('input', { type: 'text', required: true, pattern: '\\d{4}-(\\d{2}|\\d{4})', value: `${start + 1}-${start + 2}` });
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
        h('div', { class: 'notice' }, 'Es copien els mòduls, les tasques compartides i el seu ordre. No es copien el professorat, els grups, l\'alumnat ni cap progrés.'),
        field('Nom del projecte nou', name),
        field('Curs acadèmic', year),
        field('Descripció', description),
        h('div', { class: 'card-actions' }, save));
      const dialog = modal({ title: 'Duplica el projecte', body: form });
    }

    append(content, 
      h('div', { class: 'card' },
        h('h2', {}, 'Dades del projecte'),
        h('p', { class: 'muted' }, `Mòduls: ${project.modules.map((m) => m.name).join(', ') || 'cap'}`),
        moduleChips(project.modules),
        h('div', { class: 'card-actions' },
          h('button', { class: 'btn', type: 'button', disabled: !writable, onClick: () => openProjectForm({ project, onSaved: reload }).catch(showError) }, 'Edita el projecte'))),
      isAdmin
        ? h('div', { class: 'card' },
        h('h2', {}, 'Professorat assignat'),
        h('p', { class: 'muted' }, 'El professorat assignat pot gestionar totes les tasques i tots els grups del projecte, independentment dels mòduls.'),
        teacherList.el,
        h('div', { class: 'card-actions' }, saveTeachers))
        : h('div', { class: 'card' },
            h('h2', {}, 'Professorat assignat'),
            h('ul', { class: 'member-list' }, project.teachers.map((t) =>
              h('li', {}, h('div', {}, h('strong', {}, t.name), h('div', { class: 'muted' }, t.email))))),
            writable ? addTeacherForm() : null,
            h('p', { class: 'muted', style: { 'margin-top': '10px' } }, "Per treure professorat d'aquest projecte, contacta amb administració.")),
      h('div', { class: 'card' },
        h('h2', {}, 'Cicle de vida'),
        h('p', { class: 'muted' }, 'Duplica el projecte per a un curs nou o arxiva\'l quan acabi.'),
        h('div', { class: 'card-actions' },
          h('button', { class: 'btn', type: 'button', onClick: openDuplicate }, 'Duplica per a un altre curs'),
          archive))
    );
  }
}
