// Adapter for the user's existing scene. Demo jobs never represent real work.
(() => {
  const sim = window.floorSimulation;
  if (!sim) return;
  sim.jobs = [];
  let mission = null, reduced = false;
  const tick = sim.tick.bind(sim);
  sim.tick = (dt) => {
    // Keep walking/briefing choreography, but never infer completion from elapsed time.
    sim.workers.forEach((worker) => { if (worker.state === 'working') worker.timer = 100000; });
    tick(dt);
  };
  window.roomState = () => ({ paused: reduced || !mission || ['preview','completed','failed','cancelled'].includes(mission.status), day: false });
  const roles = ['TAPE','QUANT','MACRO','RISK','FLOW','PM'];
  window.addEventListener('deskselect', event => {
    const slot = roles.indexOf(event.detail);
    if (slot >= 0) parent.postMessage({type:'cao-desk-selected',slot},location.origin);
  });
  window.addEventListener('keydown', event => {
    if(event.key === 'Escape') parent.postMessage({type:'cao-scene-escape'},location.origin);
    if(event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); parent.postMessage({type:'cao-scene-room',key:event.key},location.origin); }
  });
  const seen = new Set();
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'cao-mission') return;
    const next = event.data.mission;
    reduced = event.data.reducedMotion === true;
    document.querySelector('nav').hidden = event.data.immersive === true;
    if (next?.id !== mission?.id) { sim.jobs = []; seen.clear(); }
    mission = next;
    (mission?.workers ?? []).slice(0,6).forEach((worker, index) => {
      const actor = sim.workers[index];
      const key = `${mission.id}:${worker.targetId}`;
      if (worker.status === 'running' && !seen.has(key)) {
        seen.add(key); sim.queue(worker.assignment, actor.id, key);
      }
      if (['done','failed','cancelled'].includes(worker.status)) {
        actor.state = 'waiting'; actor.task = null;
        sim.jobs = sim.jobs.filter((job) => job.id !== key);
      }
    });
  });
  const label = () => {
    (window.staffRigs ?? []).forEach((actor, index) => {
      const worker = mission?.workers?.[index];
      if (actor.badge) actor.badge.style.visibility = actor.id === 'CHIEF' || worker ? 'visible' : 'hidden';
      const title = actor.badge?.querySelector('b');
      const state = actor.badge?.querySelector('span');
      if (title) title.textContent = actor.id === 'CHIEF' ? 'Jarvis CAO' : worker ? (worker.title || `Agent ${index + 1}`) : 'Available';
      if (state) state.textContent = actor.id === 'CHIEF' ? (mission?.status ?? 'Ready') : (worker?.status ?? '');
    });
  };
  setInterval(label, 500);
  const quality = document.getElementById('quality');
  quality.value = 'performance'; quality.dispatchEvent(new Event('change'));
})();
