/**
 * 아주 작은 드래그 정렬.
 *
 * 라이브러리를 붙이지 않고 HTML5 drag&drop 만 쓴다. 항목마다 data-id 가 있어야 하고,
 * 순서가 바뀌면 새 id 배열을 onReorder 로 넘긴다.
 *
 * 마우스가 없거나 못 쓰는 경우를 위해 Alt+↑/↓ 로도 같은 조작이 된다 —
 * 드래그만 지원하는 정렬은 키보드 사용자에게 기능이 통째로 없는 것과 같기 때문.
 */
export function makeSortable(container, { onReorder, itemSelector = '[data-id]' } = {}) {
  let dragging = null;

  const items = () => [...container.querySelectorAll(itemSelector)];
  const idsOf = () => items().map((el) => Number(el.dataset.id));

  function commit() {
    onReorder?.(idsOf());
  }

  for (const el of items()) {
    el.draggable = true;
    el.tabIndex = 0;

    el.addEventListener('dragstart', (e) => {
      dragging = el;
      el.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
      // Firefox 는 데이터가 없으면 드래그를 시작하지 않는다.
      e.dataTransfer.setData('text/plain', el.dataset.id);
    });

    el.addEventListener('dragend', () => {
      if (dragging) dragging.style.opacity = '';
      dragging = null;
      for (const other of items()) other.style.borderTop = '';
      commit();
    });

    el.addEventListener('dragover', (e) => {
      if (!dragging || dragging === el) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const box = el.getBoundingClientRect();
      const after = e.clientY > box.top + box.height / 2;
      el.parentNode.insertBefore(dragging, after ? el.nextSibling : el);
    });

    el.addEventListener('drop', (e) => e.preventDefault());

    el.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const list = items();
      const i = list.indexOf(el);
      const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
      if (j < 0 || j >= list.length) return;
      if (e.key === 'ArrowUp') el.parentNode.insertBefore(el, list[j]);
      else el.parentNode.insertBefore(list[j], el);
      el.focus();
      commit();
    });
  }
}
