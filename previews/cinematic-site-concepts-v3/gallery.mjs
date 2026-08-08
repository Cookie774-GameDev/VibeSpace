const portals = [...document.querySelectorAll("[data-portal]")];

const resetPortal = (portal) => {
  portal.style.setProperty("--tilt-x", "0deg");
  portal.style.setProperty("--tilt-y", "0deg");
  portal.style.setProperty("--light-x", "50%");
  portal.style.setProperty("--light-y", "50%");
};

portals.forEach((portal, index) => {
  const link = portal.querySelector(".portal-link");
  resetPortal(portal);

  portal.addEventListener("pointermove", (event) => {
    const bounds = portal.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    portal.style.setProperty("--tilt-x", `${(-y * 2.6).toFixed(2)}deg`);
    portal.style.setProperty("--tilt-y", `${(x * 3.8).toFixed(2)}deg`);
    portal.style.setProperty("--light-x", `${((x + 0.5) * 100).toFixed(1)}%`);
    portal.style.setProperty("--light-y", `${((y + 0.5) * 100).toFixed(1)}%`);
  });
  portal.addEventListener("pointerleave", () => resetPortal(portal));

  link.addEventListener("keydown", (event) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const next = (index + direction + portals.length) % portals.length;
    portals[next].querySelector(".portal-link").focus();
  });
});
