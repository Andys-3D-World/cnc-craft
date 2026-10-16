export function initCollapsibleMenus() {
  // KORREKTUR: Sucht nun nach JEDEM menu-trigger in der gesamten Anwendung (Links UND Rechts!)
  const triggers = document.querySelectorAll(".menu-trigger");

  triggers.forEach((trigger: any) => {
    if (trigger.querySelector(".arrow-indicator")) return; 

    trigger.style.cursor = "pointer";
    trigger.style.display = "flex";
    trigger.style.justify = "space-between";
    trigger.style.alignItems = "center";
    trigger.style.transition = "color 0.2s";

    const arrow = document.createElement("span");
    arrow.className = "arrow-indicator";
    arrow.textContent = " ▾";
    arrow.style.fontSize = "0.75rem";
    arrow.style.transition = "transform 0.2s";
    trigger.appendChild(arrow);

    const content = trigger.nextElementSibling as HTMLElement;
    if (content) {
      content.style.overflow = "hidden";
      content.style.transition = "max-height 0.2s ease-out, opacity 0.15s ease-out";
      content.style.maxHeight = "500px"; 
      content.style.opacity = "1";

      trigger.addEventListener("click", (e: Event) => {
        e.preventDefault();
        
        if (content.style.maxHeight === "0px") {
          content.style.maxHeight = "500px";
          content.style.opacity = "1";
          arrow.style.transform = "rotate(0deg)";
        } else {
          content.style.maxHeight = "0px";
          content.style.opacity = "0";
          arrow.style.transform = "rotate(-90deg)";
        }
      });
    }
  });
}
