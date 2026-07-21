let db;
let lastBlockLevel = 0;
let activeBlockId = null;
let allCurrentDecryptedBlocks = [];
let isEnterPressing = false;
let currentlyEditingBlock = null;
let cryptoKey = null;
let currentPageUUID = null;
let autoSaveTimeout = null;
let focusedBlockId = null;
let recentPages = []; // Сюда мы будем сохранять последние открытые страницы
let navigationHistoryBack = [];    // Массив для истории "Назад"
let navigationHistoryForward = []; // Массив для истории "Вперед"
let isNavigatingViaButtons = false; // Специальный флаг, чтобы история не зацикливалась сама на себя


// Запуск базы данных IndexedDB
const request = indexedDB.open("LogbookDB", 1);

request.onupgradeneeded = function(event) {
  const db = event.target.result;
  if (!db.objectStoreNames.contains("pages")) { db.createObjectStore("pages", { keyPath: "id" }); }
  if (!db.objectStoreNames.contains("blocks")) { db.createObjectStore("blocks", { keyPath: "id" }); }
  if (!db.objectStoreNames.contains("settings")) { db.createObjectStore("settings", { keyPath: "key" }); }
  console.log("База данных успешно обновлена!");
};

request.onsuccess = function (event) {
  db = event.target.result;
  console.log("База данных успешно открыта!");
};

request.onerror = function (event) {
  console.error("Ошибка при работе с IndexedDB:", event.target.error);
};

// Главная инициализация
async function initApp() {
  const today = new Date().toISOString().split('T')[0];
  console.log("Сегодняшняя дата для Журнала:", today);
  await checkAndCreateJournalPage(today);
}

// Защищенное создание Журнала с авто-исправлением типов данных
async function checkAndCreateJournalPage(dateStr) {
  const transaction = db.transaction(["pages"], "readwrite");
  const store = transaction.objectStore("pages");
  let journalPage = null;

  const request = store.openCursor();
  request.onsuccess = async function(event) {
    const cursor = event.target.result;
    if (cursor) {
      try {
        const decryptedTitle = await decryptText(cursor.value.title);
        // УМНЫЙ ПОИСК: Ищем совпадение даты БЕЗ жесткой привязки к типу journal
        if (decryptedTitle && decryptedTitle.trim() === dateStr.trim()) {
          journalPage = cursor.value;
        }
      } catch (err) { console.error("Пропуск проверки записи:", err); }
      cursor.continue();
    } else {
      if (!journalPage) {
        console.log(`Журнал на дату ${dateStr} не найден. Создаем новую страницу.`);
        const encryptedTitle = await encryptText(dateStr);
        const newJournal = { id: crypto.randomUUID(), title: encryptedTitle, type: "journal" };

        const writeTx = db.transaction(["pages"], "readwrite");
        writeTx.objectStore("pages").add(newJournal);

        writeTx.oncomplete = async function() {
          document.getElementById("page-title").innerText = dateStr;
          currentPageUUID = newJournal.id;

          const encryptedEmptyContent = await encryptText("");
          const firstBlock = { id: crypto.randomUUID(), pageId: currentPageUUID, content: encryptedEmptyContent, level: 0, order: Date.now() };

          const blockTx = db.transaction(["blocks"], "readwrite");
          blockTx.objectStore("blocks").add(firstBlock);
          blockTx.oncomplete = function() { loadPagesList(); loadBlocks(); };
        };
      } else {
        console.log(`Запись на ${dateStr} найдена. Открываем оригинал.`);

        // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Если старая запись имела тип "page", принудительно меняем её на "journal"
        if (journalPage.type !== "journal") {
          journalPage.type = "journal";
          const updateTx = db.transaction(["pages"], "readwrite");
          updateTx.objectStore("pages").put(journalPage);
        }

        document.getElementById("page-title").innerText = dateStr;
        currentPageUUID = journalPage.id;
        loadPagesList();
        loadBlocks();
      }
    }
  };
}

// СТАНЕТ (Создание страницы с автоматическим занесением в историю переходов):
async function createCustomPage(pageName) {
  const encryptedTitle = await encryptText(pageName);
  const newPage = { id: crypto.randomUUID(), title: encryptedTitle, type: "page" };
  const transaction = db.transaction(["pages"], "readwrite");
  transaction.objectStore("pages").add(newPage);

  transaction.oncomplete = function() {
    document.getElementById("page-title").innerText = pageName;
    currentPageUUID = newPage.id;
    focusedBlockId = null;

    // СРАЗУ ЗАНОСИМ В "ПОСЛЕДНИЕ":
    if (!recentPages.includes(newPage.id)) {
      recentPages.unshift(newPage.id); // Кидаем в начало списка историю
      if (recentPages.length > 5) recentPages.pop(); // Держим лимит в 5 штук
    }

    loadPagesList(); // Перерисовываем сайдбар, чтобы новая заметка сразу появилась в "Последних"
    loadBlocks();
  };
}

// НОВАЯ ИСПРАВЛЕННАЯ ФУНКЦИЯ ДЛЯ РАЗДЕЛЕНИЯ СТРАНИЦ ПО ПОЛОЧКАМ
function loadPagesList() {
  // Находим все наши новые списки на экране
  const listRecent = document.getElementById("list-recent");
  const listJournals = document.getElementById("list-journals");
  const listNotes = document.getElementById("list-notes");
  const listTags = document.getElementById("list-tags");

  if (!listRecent || !listJournals || !listNotes || !listTags) return;

  // Очищаем все списки перед новой отрисовкой
  listRecent.innerHTML = "";
  listJournals.innerHTML = "";
  listNotes.innerHTML = "";
  listTags.innerHTML = "";

  const transaction = db.transaction(["pages", "blocks"], "readonly");
  const pagesStore = transaction.objectStore("pages");
  const blocksStore = transaction.objectStore("blocks");

  let allPagesList = [];
  let allDatabaseBlocks = [];
  let pageIdToDelete = null;

  // Шаг 1: Выкачиваем все страницы из базы
  pagesStore.openCursor().onsuccess = function (event) {
    const cursor = event.target.result;
    if (cursor) {
      allPagesList.push(cursor.value);
      cursor.continue();
    }
  };

  // Шаг 2: Выкачиваем все блоки (они нужны нам, чтобы вытащить Хэштеги/Теги!)
  // СТАНЕТ:
  let tagsSearchBlocks = []; // Создаем отдельный изолированный массив только для тегов
  blocksStore.openCursor().onsuccess = function (event) {
    const cursor = event.target.result;
    if (cursor) {
      tagsSearchBlocks.push(cursor.value); // Собираем блоки сюда
      cursor.continue();
    }
  };


  // Шаг 3: Когда все данные загружены в память, распределяем их
  transaction.oncomplete = async function() {

    // А. Сначала соберем все УНИКАЛЬНЫЕ ТЕГИ из содержимого блоков
    let uniqueTags = new Set();
    for (let block of tagsSearchBlocks) {
      try {
        const decryptedContent = await decryptText(block.content);
        if (decryptedContent) {
          // Ищем слова, начинающиеся с #
          const matches = decryptedContent.match(/#([a-zA-Zа-яА-Я0-9_ёЁ]+)/g);
          if (matches) {
            matches.forEach(tag => uniqueTags.add(tag.replace("#", "").trim()));
          }
        }
      } catch (e) {}
    }

    // Превращаем теги в массив и сортируем по алфавиту
    let sortedTags = Array.from(uniqueTags).sort((a, b) => a.localeCompare(b));

    // СТАНЕТ:
    // Б. Расшифровываем заголовки страниц
    let decryptedPages = [];
    for (let p of allPagesList) {
      const clearTitle = await decryptText(p.title);

      // Проверяем, является ли эта страница тегом (есть ли такое слово среди найденных тегов)
      const isThisATag = sortedTags.includes(clearTitle.trim());
      let finalType = p.type;
      if (isThisATag) finalType = "tag"; // Маркируем как тег в памяти

      decryptedPages.push({ id: p.id, title: clearTitle, type: finalType });
    }

    // Сортируем списки по алфавиту с учетом тегов
    let journalPages = decryptedPages.filter(p => p.type === "journal").sort((a, b) => a.title.localeCompare(b.title));
    // В "Заметки" пускаем только то, что НЕ журнал и НЕ тег!
    let notePages = decryptedPages.filter(p => p.type !== "journal" && p.type !== "tag").sort((a, b) => a.title.localeCompare(b.title));

    // Вспомогательная функция для создания кликабельной строчки в сайдбаре
    function createSidebarItem(pageId, pageTitleText) {
      const li = document.createElement("li");
      li.innerText = pageTitleText;

      li.addEventListener("click", function () {
        document.getElementById("page-title").innerText = pageTitleText;
        currentPageUUID = pageId;
        focusedBlockId = null;

        // СТАНЕТ:
        // Добавляем страницу в список "Последние" (если это НЕ тег и её там еще нет)
        const clickedPageObj = decryptedPages.find(p => p.id === pageId);
        const isTagClick = clickedPageObj && clickedPageObj.type === "tag";

        if (!isTagClick) {
          if (!recentPages.includes(pageId)) {
            recentPages.unshift(pageId);
            if (recentPages.length > 5) recentPages.pop();
          } else {
            recentPages = recentPages.filter(id => id !== pageId);
            recentPages.unshift(pageId);
          }
        }

        loadBlocks();
        loadPagesList(); // Перерисовываем сайдбар, чтобы обновить блок "Последние"

        // Закрываем сайдбар на мобилках
        if (window.innerWidth <= 768) {
          const mobileSidebar = document.querySelector(".sidebar");
          const mobileOverlay = document.getElementById("sidebar-overlay");
          if (mobileSidebar && mobileOverlay) {
            mobileSidebar.classList.remove("mobile-open");
            mobileOverlay.classList.remove("mobile-open");
          }
        }
      });

      // Кастомное контекстное меню для удаления (вызывается правой кнопкой мыши)
      li.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        e.stopPropagation();
        pageIdToDelete = pageId;
        const menu = document.getElementById("context-menu");
        if (menu) {
          menu.style.display = "block";
          menu.style.left = e.pageX + "px";
          menu.style.top = e.pageY + "px";
        }
      });

      return li;
    }

    // ВЫВОДИМ ДАННЫЕ НА ЭКРАН ПО РАЗДЕЛАМ:

    // 1. Выводим Последние заметки
    // СТАНЕТ (Умная и безопасная отрисовка последних заметок):
    // 1. Выводим Последние заметки
    recentPages.forEach(id => {
      const foundPage = decryptedPages.find(p => p.id === id);
      if (foundPage) {
        // Если тип четко равен journal — ставим календарь, во всех остальных случаях — документ
        const isJournal = (foundPage.type && foundPage.type.trim() === "journal");
        const prefix = isJournal ? "📅 " : "📄 ";

        // Добавляем элемент в список
        listRecent.appendChild(createSidebarItem(foundPage.id, prefix + foundPage.title));
      }
    });

    // Если последних нет — пишем заглушку
    if (recentPages.length === 0) {
      listRecent.innerHTML = "<li style='font-style:italic; color:#acaba4; pointer-events:none; font-size:12px;'>Пусто ⏳</li>";
    }

    // 2. Выводим Журналы
    journalPages.forEach(p => {
      listJournals.appendChild(createSidebarItem(p.id, p.title));
    });

    // 3. Выводим Заметки
    notePages.forEach(p => {
      listNotes.appendChild(createSidebarItem(p.id, p.title));
    });

    // 4. Выводим Теги
    sortedTags.forEach(tag => {
      const li = document.createElement("li");
      //li.id = "li-block-" + block.id; // Присваиваем строке её честный ID для якорных ссылок
      li.innerText = "#" + tag;
      li.addEventListener("click", function() {
        // При клике на тег — создаем или открываем страницу с именем этого тега (как в Logseq!)
        checkAndCreatePage(tag, "tag");
      });
      listTags.appendChild(li);
    });
    // Если тегов нет — пишем заглушку
    if (sortedTags.length === 0) {
      listTags.innerHTML = "<li style='font-style:italic; color:#acaba4; pointer-events:none; font-size:12px;'>Нет тегов 🏷️</li>";
    }
  };

  // Привязка удаления страницы к кнопке из контекстного меню (оставляем твой оригинальный рабочий код)
  const deleteBtn = document.getElementById("btn-delete-page");
  if (deleteBtn) {
    deleteBtn.onclick = async function(e) {
      e.preventDefault();
      if (!pageIdToDelete) return;
      const menu = document.getElementById("context-menu");
      if (menu) menu.style.display = "none";

      try {
        const transaction = db.transaction(["pages"], "readonly");
        const store = transaction.objectStore("pages");
        const pageData = await new Promise((resolve) => {
          const req = store.get(pageIdToDelete);
          req.onsuccess = () => resolve(req.result);
        });

        if (pageData) {
          const pageTitleText = await decryptText(pageData.title);
          if (confirm(`Вы уверены, что хотите полностью удалить страницу "${pageTitleText}" и все её зашифрованные записи?`)) {
            // Удаляем из списка последних, если она там была
            recentPages = recentPages.filter(id => id !== pageIdToDelete);

            const pageTx = db.transaction(["pages"], "readwrite");
            pageTx.objectStore("pages").delete(pageIdToDelete);

            pageTx.oncomplete = function() {
              const blockTx = db.transaction(["blocks"], "readwrite");
              const blockStore = blockTx.objectStore("blocks");
              blockStore.openCursor().onsuccess = function(event) {
                const cursor = event.target.result;
                if (cursor) {
                  if (cursor.value.pageId === pageIdToDelete) { cursor.delete(); }
                  cursor.continue();
                } else {
                  pageIdToDelete = null;
                  initApp();
                }
              };
            };
          } else { pageIdToDelete = null; }
        }
      } catch (err) { console.error("Ошибка удаления:", err); pageIdToDelete = null; }
    };
  }
}

// ЖЕЛЕЗОБЕТОННАЯ ПЕРЕНУМЕРАЦИЯ С ВОЗВРАТОМ ЧИСТОГО МАССИВА
async function reorderAndSaveBlocks(blocksArray) {
  if (!blocksArray || blocksArray.length === 0) return [];

  const tx = db.transaction(["blocks"], "readwrite");
  const store = tx.objectStore("blocks");

  // Создаем новый массив, который вернем приложению
  const savedBlocks = [];

  for (let i = 0; i < blocksArray.length; i++) {
    const bToSave = Object.assign({}, blocksArray[i]);

    // Жестко раздаем правильный цельный порядок
    bToSave.order = (i + 1) * 10;

    if (bToSave.content.length < 32 || !/^[a-f0-9]{32,}$/i.test(bToSave.content)) {
      bToSave.content = await encryptText(bToSave.content);
    }

    store.put(bToSave);
    savedBlocks.push(bToSave); // Сохраняем обновленный блок
  }

  return new Promise((resolve) => {
    tx.oncomplete = () => {
      // ИСПРАВЛЕНИЕ: Обновляем глобальную память приложения чистыми индексами
      allCurrentDecryptedBlocks = savedBlocks;
      resolve(savedBlocks);
    };
  });
}


// Быстрая выгрузка блоков + ПОИСК УПОМИНАНИЙ И ТЕГОВ (Linked References)
// СТАНЕТ:
function loadBlocks() {
  const blockListElement = document.getElementById("blocks-list");
  if (!blockListElement) return;
  blockListElement.innerHTML = "";

  // === СИСТEМA ИСТOРИИ НАВИГАЦИИ ===
  // Если мы перешли на страницу обычным кликом (не кнопками Назад/Вперед)
  // СТАНЕТ:
  if (!isNavigatingViaButtons && currentPageUUID) {
    // Берем самый первый ID из истории (это и есть страница, с которой мы только что ушли)
    const previousPageId = navigationHistoryBack.length > 0 ? navigationHistoryBack[0] : null;

    if (previousPageId !== currentPageUUID) {
      navigationHistoryBack.unshift(currentPageUUID);
      navigationHistoryForward = [];
    }
  }

  // ==================================

  const currentPageId = currentPageUUID;

  const rawBlocks = [];
  const allDatabaseBlocks = []; // Сюда соберем вообще все блоки для поиска тегов

  const transaction = db.transaction(["blocks"], "readonly");
  const store = transaction.objectStore("blocks");

  store.openCursor().onsuccess = function (event) {
    const cursor = event.target.result;
    if (cursor) {
      const block = cursor.value;
      allDatabaseBlocks.push(block); // Сохраняем для анализа тегов
      if (block.pageId === currentPageId) { rawBlocks.push(block); }
      cursor.continue();
    } else {
      // 1. Отрисовываем основные блоки текущей страницы
      processAndRenderBlocks(rawBlocks);

      // 2. Запускаем поиск упоминаний этого тега/страницы по всей базе данных
      renderLinkedReferences(allDatabaseBlocks);

      // === НАШ ДОБАВЛЕННЫЙ БЛОК ДЛЯ СKPОЛЛA И ВСПЫШКИ ===
      // Как только весь контент выведен в HTML, даем один кадр анимации
      // на отрисовку и плавно подсвечиваем якорную строку!
      requestAnimationFrame(function() {
        if (typeof window.highlightAnchorBlock === 'function') {
          window.highlightAnchorBlock();
        }
      });
      // ==================================================
    }
  };
}

// УМНАЯ И ИНФОРМАТИВНАЯ ОТРИСОВКА СВЯЗАННЫХ ТЕГОВ И УПОМИНАНИЙ (В СТИЛЕ LOGSEQ)
async function renderLinkedReferences(allBlocks) {
  const refArea = document.getElementById("linked-references-area");
  const refList = document.getElementById("linked-references-list");
  const currentTitle = document.getElementById("page-title").innerText.trim().toLowerCase();

  if (!refArea || !refList || currentTitle === "") return;
  refList.innerHTML = "";
  let matchesCount = 0;

  // 1. Сначала выкачиваем все страницы в память, чтобы мгновенно находить их названия по ID
  const allPages = [];
  const pageTx = db.transaction(["pages"], "readonly");
  pageTx.objectStore("pages").openCursor().onsuccess = function(e) {
    const cursor = e.target.result;
    if (cursor) { allPages.push(cursor.value); cursor.continue(); }
  };

  // Ждем закрытия транзакции страниц перед началом анализа блоков
  await new Promise(resolve => pageTx.oncomplete = resolve);

  // 2. Бежим по всем блокам базы данных
  for (let block of allBlocks) {
    if (block.pageId === currentPageUUID) continue; // Пропускаем блоки этой же страницы

    const decryptedContent = await decryptText(block.content);
    if (!decryptedContent || decryptedContent.trim() === "") continue;

    const lowerContent = decryptedContent.toLowerCase();

    // Ищем упоминание тега или вики-ссылки на текущую страницу
    const hasTag = lowerContent.includes("#" + currentTitle);
    //const hasWiki = lowerContent.includes("[[" + currentTitle + "]]") || lowerContent.includes("[[" + currentTitle + "|");

    if (hasTag) {
      matchesCount++;

      // Находим саму страницу в памяти, чтобы узнать её человеческое заголовок
      const targetPageObj = allPages.find(p => p.id === block.pageId);
      const pageTitleText = targetPageObj ? await decryptText(targetPageObj.title) : "Неизвестная заметка";

      // Создаем красивый контейнер для упоминания
      const containerLi = document.createElement("li");
      containerLi.style.cssText = "margin-bottom: 16px; padding: 12px; background-color: #f5f4f0; border: 1px solid #e3e2dc; border-radius: 6px; font-size: 14px; box-shadow: inset 0 1px 2px rgba(0,0,0,0.02);";

      // А. Создаем КЛИКАБЕЛЬНЫЙ ЗАГОЛОВОК страницы, на которой найден тег
      const headerDiv = document.createElement("div");
      headerDiv.style.cssText = "font-weight: 700; color: #2b6cb0; margin-bottom: 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; display: inline-block;";
      headerDiv.innerText = "📄 " + pageTitleText;

      // Клик по заголовку плашки переносит внутрь этой заметки
      headerDiv.addEventListener("click", function(e) {
        e.stopPropagation();

        // ВМЕСТО СТАРОГО РУЧНОГО ПЕРЕКЛЮЧЕНИЯ ЗАПУСКАЕМ НАШУ УМНУЮ НАВИГАЦИЮ!
        focusedBlockId = block.id; // Запоминаем фокус на строку
        checkAndCreatePage(pageTitleText, "page"); // Открываем страницу по-взрослому
      });


      // Б. Создаем блок с ТЕКСТОМ ЗАМЕТКИ (контекстом)
      const contentDiv = document.createElement("div");
      contentDiv.style.cssText = "color: #2c2c2c; padding-left: 10px; border-left: 2px solid #7c7c77; margin-top: 4px; line-height: 1.4;";

      // Очищаем текст от внутренних ломающих вики-ссылок на саму себя, но рендерим остальной Markdown
      contentDiv.innerHTML = parseMarkdown(decryptedContent);

      // Собираем плашку воедино
      containerLi.appendChild(headerDiv);
      containerLi.appendChild(contentDiv);
      refList.appendChild(containerLi);
    }
  }

  // Показываем или скрываем область упоминаний
  if (matchesCount > 0) {
    refArea.style.display = "block";
  } else {
    refArea.style.display = "none";
  }
}

// Асинхронный рендеринг блоков в памяти
async function processAndRenderBlocks(pageBlocks) {
  const blockListElement = document.getElementById("blocks-list");

  // Расшифровываем тексты без риска закрытия транзакции базы
  for (let block of pageBlocks) {
    block.content = await decryptText(block.content);
  }

  pageBlocks.sort((a, b) => (a.order || 0) - (b.order || 0));

  // --- ЛОГИКА РЕЖИМА ZOOM (ФОКУСИРОВКА БЛОКОВ) ---
  const btnFocusOut = document.getElementById("btn-focus-out");
  let focusLevel = 0, allowedOrders = [];

  if (focusedBlockId) {
    if (btnFocusOut) btnFocusOut.style.display = "inline-block";
    const targetIdx = pageBlocks.findIndex(b => b.id === focusedBlockId);
    if (targetIdx !== -1) {
      const targetBlock = pageBlocks[targetIdx];
      focusLevel = targetBlock.level || 0;
      allowedOrders.push(targetBlock.id);
      for (let i = targetIdx + 1; i < pageBlocks.length; i++) {
        if ((pageBlocks[i].level || 0) > focusLevel) {
          allowedOrders.push(pageBlocks[i].id);
        } else { break; }
      }
    }
  } else {
    if (btnFocusOut) btnFocusOut.style.display = "none";
  }

  allCurrentDecryptedBlocks = pageBlocks;

  // Цикл отрисовки каждой отдельной строки
  pageBlocks.forEach(function (block, index) {
    const currentLevel = block.level !== undefined ? block.level : 0;
    if (focusedBlockId && !allowedOrders.includes(block.id)) return;

    const visualLevel = focusedBlockId ? Math.max(0, currentLevel - focusLevel) : currentLevel;
    //let isChildOfHidden = false;
    // СТАНЕТ (Идеальный расчет вложенности без ложных склеиваний):
    let isChildOfHidden = false;
    let currentSearchLevel = currentLevel;

    for (let i = index - 1; i >= 0; i--) {
      const prevBlock = pageBlocks[i];
      const prevLevel = prevBlock.level !== undefined ? prevBlock.level : 0;

      // Ищем только непосредственных предков (родителей, дедушек и т.д.), у которых уровень меньше нашего
      if (prevLevel < currentSearchLevel) {
        if (prevBlock.isCollapsed) {
          isChildOfHidden = true;
          break;
        }
        // Как только нашли родителя, теперь ищем предков уже для этого родителя (поднимаемся выше по лестнице)
        currentSearchLevel = prevLevel;
      }

      // Если доползли до самого верха (уровень 0) и проверили его — вот теперь можно выходить
      if (currentSearchLevel === 0 && prevLevel === 0) {
        break;
      }
    }

    if (isChildOfHidden) return;

    const li = document.createElement("li");

    if (typeof block !== 'undefined' && block && block.id) {
      li.id = "li-block-" + block.id;
    }
    const stepSize = window.innerWidth <= 768 ? 14 : 22;
    li.style.paddingLeft = (visualLevel * stepSize) + "px";

    // === СВЕТОВАЯ ИЕРАРХИЯ ЦВЕТА (НА УРОВЕНЬ LI) ===
    // Убираем визуальный шум: шаг 12%, порог 40% (не светлее цвета цитат)
    const opacityStep = 0.12;
    const minOpacity = 0.40;
    const currentOpacity = Math.max(minOpacity, 1 - (visualLevel * opacityStep));

    // Применяем прозрачность ко всей строке целиком
    li.style.opacity = currentOpacity;
    // ========================================================


    // Создание профессионального графического буллета в стиле Logseq
    const bulletSpan = document.createElement("span");

    // Добавляем базовый класс для стилей в CSS
    bulletSpan.classList.add("bullet-point");

    // Если блок свернут, добавляем специальный класс для тени вокруг точки
    if (block.isCollapsed) {
      bulletSpan.classList.add("bullet-collapsed");
    }

    bulletSpan.addEventListener("click", async function(e) {
      e.stopPropagation();
      if (e.ctrlKey || e.altKey) { focusedBlockId = block.id; loadBlocks(); return; }
      let hasChildren = false;
      if (index < pageBlocks.length - 1) {
        if ((pageBlocks[index + 1].level || 0) > currentLevel) hasChildren = true;
      }
      if (!hasChildren && !block.isCollapsed) return;
      block.isCollapsed = !block.isCollapsed;
      const blockToSave = Object.assign({}, block);
      blockToSave.content = await encryptText(blockToSave.content);
      const writeTx = db.transaction(["blocks"], "readwrite");
      writeTx.objectStore("blocks").put(blockToSave);
      writeTx.oncomplete = function() {
        // Даем экрану один кадр на передышку, чтобы избежать визуальных зависаний
        requestAnimationFrame(function() {
          loadBlocks();
        });
      };
    });

    const textSpan = document.createElement("span");
    textSpan.innerHTML = block.content ? parseMarkdown(block.content) : "&nbsp;";
    textSpan.style.cursor = "text";
    textSpan.style.flexGrow = "1";
    textSpan.style.display = "inline-block";
    textSpan.style.minHeight = "24px";

    // === СВЕТОВАЯ ИЕРАРХИЯ ЦВЕТА ТЕКСТА (УБИРАЕМ ВИЗУАЛЬНЫЙ ШУМ) ===
    // visualLevel равен 0 для корневых блоков и ВСЕГДА сбрасывается в 0 для главного блока в режиме Zoom!
    // Мы плавно уменьшаем непрозрачность (opacity) на 12% с каждым шагом вложенности.
    // Ограничиваем падение на уровне 5-го шага (минимальная видимость текста — 40%)
    // const opacityStep = 0.12;
    // const minOpacity = 0.40;
    // const currentOpacity = Math.max(minOpacity, 1 - (visualLevel * opacityStep));

    // Применяем вычисленную прозрачность к тексту блока
    // textSpan.style.opacity = currentOpacity;
    // ===============================================================

    let touchTimer = null;

    // Одиночный клик для выделения строки + УМНЫЙ ЯКОРНЫЙ ПЕРЕХОД ПО ССЫЛКАМ
    textSpan.addEventListener("click", function (e) {

      // === НАШ ВРЕМЕННЫЙ СВЕРХ-ШПИОН НА ВХОДЕ ===
      //alert(`Клик зафиксирован! \nНажали на тег: <${e.target.tagName.toLowerCase()}> \nКлассы элемента: "${e.target.className}" \nID из data-id: "${e.target.getAttribute("data-id")}"`);
      // ==========================================

      // А. Если кликнули строго по вики-ссылке [[Страница]] или хештегу #тег
      if (e.target.classList.contains("page-link")) {
        e.preventDefault();
        e.stopPropagation();
        checkAndCreatePage(e.target.getAttribute("data-page"), "page");
        return;
      }

      // Б. Если кликнули по перекрёстной ссылке на блок ((uuid))
      if (e.target.classList.contains("block-ref")) {
        e.preventDefault();
        e.stopPropagation();

        // Считываем ID целевого блока и ID его родной страницы напрямую из атрибутов ссылки!
        const targetBlockId = e.target.getAttribute("data-block-id");

        // Так как парсер Logseq зашивает имя или ID страницы, давай проверим, куда нам лететь.
        // Самый быстрый способ узнать имя страницы — вытащить его из базы по ID блока,
        // но чтобы клик не вис, мы сделаем это через классический быстрый .onsuccess:
        if (!targetBlockId) return;

        const tx = db.transaction(["blocks"], "readonly");
        tx.objectStore("blocks").get(targetBlockId).onsuccess = function(event) {
          const linkedBlock = event.target.result;

          if (linkedBlock && linkedBlock.pageId) {
            // Если блок из этой же самой заметки — просто плавно скроллим к нему
            // Если блок из этой же самой заметки — просто плавно скроллим к нему (ИСПРАВЛЕНО ДЛЯ МОБИЛЬНЫХ)
            if (linkedBlock.pageId === currentPageUUID) {
              window.anchorBlockId = targetBlockId;
              requestAnimationFrame(function() {
                if (typeof window.highlightAnchorBlock === 'function') window.highlightAnchorBlock();
              });
              return;
            }


            // Если блок из ДРУГОЙ заметки — достаем паспорт этой страницы
            const pageTx = db.transaction(["pages"], "readonly");
            pageTx.objectStore("pages").get(linkedBlock.pageId).onsuccess = async function(e2) {
              const pageData = e2.target.result;
              if (pageData) {
                const clearPageTitle = await decryptText(pageData.title);

                // === НАШ СЛЕДСТВЕННЫЙ ШПИОН ===
                //alert(`ПРЫЖОК ((uuid))! \nЦелевая страница: "${clearPageTitle}" \nID целевого блока: "${targetBlockId}"`);
                // ==============================

                // Взводим маяки строго ДО перехода на страницу!
                focusedBlockId = null;
                window.anchorBlockId = targetBlockId;

                // Переключаем экран на целевую заметку
                checkAndCreatePage(clearPageTitle, "page");
              }
            };
          }
        };
        return;
      }

      // В. Если кликнули просто по тексту — срабатывает стандартное выделение строки
      e.stopPropagation();
      document.querySelectorAll("#blocks-list li").forEach(el => el.classList.remove("selected-node"));
      li.classList.add("selected-node");
      document.getElementById("wysiwyg-toolbar").style.display = "flex";
      currentlyEditingBlock = { block: block, index: index, pageBlocks: pageBlocks };
    });



    // Функция создания поля ввода текста
    function enterEditMode() {
      if (li.querySelector("textarea")) return;
      const editInput = document.createElement("textarea");
      editInput.value = block.content;
      editInput.style.flexGrow = "1";
      editInput.style.fontSize = "16px";
      editInput.style.padding = "4px";
      editInput.style.fontFamily = "inherit";
      editInput.style.resize = "none";
      editInput.style.height = textSpan.offsetHeight + "px";
      textSpan.style.display = "none";
      li.insertBefore(editInput, textSpan);
      editInput.focus();
      currentlyEditingBlock = { block: block, index: index, pageBlocks: pageBlocks };

      // ИСПРАВЛЕННОЕ СВЕРХБЫСТРОЕ АВТОСОХРАНЕНИЕ ОДНОГО БЛОКА
      editInput.addEventListener("input", function() {
        this.style.height = "auto";
        this.style.height = this.scrollHeight + "px";
        if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
        autoSaveTimeout = setTimeout(async function() {
          const newContent = editInput.value.trim();
          if (block.content !== newContent) {
            block.content = newContent;

            // Создаем копию только ОДНОГО текущего блока
            const blockToSave = Object.assign({}, block);

            // ИСПРАВЛЕНИЕ: Оставляем его родной рабочий уровень и порядок, шифруем только новый текст!
            blockToSave.content = await encryptText(newContent);
            blockToSave.level = block.level !== undefined ? block.level : 0;
            blockToSave.order = block.order;

            // Записываем одиночный блок напрямую в хранилище, не трогая остальные строки
            const transaction = db.transaction(["blocks"], "readwrite");
            transaction.objectStore("blocks").put(blockToSave);
          }
        }, 500);
      });

      async function saveChanges() {
        const newContent = editInput.value.trim();
        const blockToSave = Object.assign({}, block);
        blockToSave.content = await encryptText(newContent);
        const transaction = db.transaction(["blocks"], "readwrite");
        transaction.objectStore("blocks").put(blockToSave);
        transaction.oncomplete = function () { loadBlocks(); };
      }

      editInput.addEventListener("keydown", async function (event) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault(); isEnterPressing = true; const currentContent = editInput.value.trim();
          if (currentContent === "") {
            if (block.level > 0) {
              block.level--; const blockToSave = Object.assign({}, block); blockToSave.content = await encryptText("");
              const transaction = db.transaction(["blocks"], "readwrite"); transaction.objectStore("blocks").put(blockToSave);
              transaction.oncomplete = function () { activeBlockId = block.id; loadBlocks(); };
            } else {
              if (index > 0) activeBlockId = pageBlocks[index - 1].id; else if (pageBlocks.length > 1) activeBlockId = pageBlocks[index + 1].id;
              else { activeBlockId = block.id; isEnterPressing = false; loadBlocks(); return; }
              const deleteTx = db.transaction(["blocks"], "readwrite"); deleteTx.objectStore("blocks").delete(block.id); deleteTx.oncomplete = function () { loadBlocks(); };
            }
            return;
          }
          const blockToSave = Object.assign({}, block); blockToSave.content = await encryptText(currentContent);
          const transaction = db.transaction(["blocks"], "readwrite"); transaction.objectStore("blocks").put(blockToSave);
          transaction.oncomplete = function () { setTimeout(function() { isEnterPressing = false; }, 50); loadBlocks(); }; return;
        }
        if (event.key === "Escape") loadBlocks();
        if (event.key === "Tab") {
          event.preventDefault(); if (block.level === undefined) block.level = 0;
          if (event.shiftKey) {
            if (block.level > 0) {
              block.level--; const blockToSave = Object.assign({}, block); blockToSave.content = await encryptText(blockToSave.content);
              const transaction = db.transaction(["blocks"], "readwrite"); transaction.objectStore("blocks").put(blockToSave); transaction.oncomplete = function () { loadBlocks(); };
            }
          } else {
            if (index > 0) {
              const previousBlock = pageBlocks[index - 1]; const prevLevel = previousBlock.level !== undefined ? previousBlock.level : 0;
              if (block.level <= prevLevel) {
                block.level++; const blockToSave = Object.assign({}, block); blockToSave.content = await encryptText(blockToSave.content);
                const transaction = db.transaction(["blocks"], "readwrite"); transaction.objectStore("blocks").put(blockToSave); transaction.oncomplete = function () { loadBlocks(); };
              }
            }
          }
        }
      });

      editInput.addEventListener("blur", function (e) {
              // Делаем небольшую паузу, чтобы Android успел определить, куда именно переместился фокус
              setTimeout(function() {
                // Проверяем: если новый активный элемент — это кнопка внутри нашей панели, панель ПРЯТАТЬ НЕ НАДО!
                const activeEl = document.activeElement;
                const clickedInsideToolbar = activeEl && activeEl.closest("#wysiwyg-toolbar");

                if (document.activeElement.tagName !== "TEXTAREA" && !clickedInsideToolbar) {
                  // Прячем панель только в том случае, если пользователь кликнул совсем мимо (например, на сайдбар)
                  document.getElementById("wysiwyg-toolbar").style.display = "none";
                }
              }, 200);

              // Сохраняем изменения в текст заметки
              if (!isEnterPressing) { saveChanges(); } else { isEnterPressing = false; }
            });
    } // Конец enterEditMode

    // 2. ДВУКРАТНЫЙ КЛИК (Для ПК)
    textSpan.addEventListener("dblclick", function(e) { e.stopPropagation(); enterEditMode(); });

    // 3. ДОЛГОЕ НАЖАТИЕ (Для мобильных)
    textSpan.addEventListener("touchstart", function(e) { touchTimer = setTimeout(function() { enterEditMode(); }, 600); }, { passive: true });
    textSpan.addEventListener("touchend", function() { if (touchTimer) clearTimeout(touchTimer); });
    textSpan.addEventListener("touchmove", function() { if (touchTimer) clearTimeout(touchTimer); });

    li.appendChild(bulletSpan);
    li.appendChild(textSpan);
    blockListElement.appendChild(li);

    if (block.id === activeBlockId) { activeBlockId = null; requestAnimationFrame(function() { textSpan.click(); }); }
    lastBlockLevel = block.level !== undefined ? block.level : 0;
  }); // Конец цикла pageBlocks.forEach

  const blockMenu = document.getElementById("block-context-menu");
  if (blockMenu) blockMenu.style.display = "none";

  // ИСПРАВЛЕНИЕ: Сначала подгружаем все внешние блоки, и ТОЛЬКО ПОТОМ запускаем скролл!
  requestAnimationFrame(function() {
    resolveExternalBlockReferences(function() {
      if (typeof window.highlightAnchorBlock === 'function') {
        window.highlightAnchorBlock();
      }
    });
  });
} // Конец функции processAndRenderBlocks

document.getElementById("btn-journal").addEventListener("click", function () { initApp(); });

document.getElementById("btn-create-page").addEventListener("click", function () {
  const input = document.getElementById("new-page-input"); if (!input) return;
  const pageName = input.value.trim(); if (pageName === "") return;

  createCustomPage(pageName);
  input.value = "";

  // АВТО-ЗАКРЫТИЕ ПОСЛЕ СОЗДАНИЯ: Прячем сайдбар на смартфонах
  if (window.innerWidth <= 768) {
    const mobileSidebar = document.querySelector(".sidebar");
    const mobileOverlay = document.getElementById("sidebar-overlay");
    if (mobileSidebar && mobileOverlay) {
      mobileSidebar.classList.remove("mobile-open");
      mobileOverlay.classList.remove("mobile-open");
    }
  }
});


// НАДЕЖНЫЙ ПАРСЕР MARKDOWN С ПОДДЕРЖКОЙ КРАСИВЫХ БЛОКОВ КОДА И ЗАЧЕРКИВАНИЯ
function parseMarkdown(text) {
  if (!text || text.trim() === "") return `<span style="display:inline-block; width:100%; min-height:24px;">&nbsp;</span>`;
  try {
    let processedText = text;

    // 0. ПОДДЕРЖКА ВНЕШНИХ ИНТЕРНЕТ-ССЫЛОК [Текст](https://...)
    processedText = processedText.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (match, linkText, url) {
      return `<a href="${url}" target="_blank" class="external-web-link">${linkText}</a>`;
    });

    // 1. ПОДДЕРЖКА ВИКИ-ССЫЛОК [[Страница]] и [[Страница|псевдоним]]
    processedText = processedText.replace(/\[\[(.*?)\]\]/g, function (match, innerContent) {
      if (innerContent.includes('|')) {
        const parts = innerContent.split('|');
        const pageName = parts.shift().trim();
        const aliasName = parts.pop().trim();
        return `<a href="#" class="page-link" data-page="${pageName}">${aliasName}</a>`;
      } else {
        return `<a href="#" class="page-link" data-page="${innerContent.trim()}">${innerContent.trim()}</a>`;
      }
    });

    // 2. ПОДДЕРЖКА ХЕШТЕГОВ #тег
    processedText = processedText.replace(/#([a-zA-Zа-яА-Я0-9_ёЁ]+)/g, function (match, tagName) {
      return `<a href="#" class="page-link" data-page="${tagName}">#${tagName}</a>`;
    });

    // А. Поддержка чекбоксов [ ] и [x] (Списки задач)
    processedText = processedText.replace(/^\[ \]\s(.*)/g, '<input type="checkbox" disabled style="margin-right: 8px; vertical-align: middle;">$1');
    processedText = processedText.replace(/^\[x\]\s(.*)/g, '<input type="checkbox" checked disabled style="margin-right: 8px; vertical-align: middle;"><s>$1</s>');

    // Б. Поддержка выделения текста маркером ==текст==
    processedText = processedText.replace(/==([^=]+)==/g, '<mark style="background-color: #f7e799; padding: 2px 4px; border-radius: 4px; color: #1a1a1a;">$1</mark>');

    // В. Поддержка цитат > text
    if (processedText.startsWith('>')) {
      processedText = processedText.replace(/^>\s?(.*)/g, '<blockquote style="margin: 4px 0; padding-left: 12px; border-left: 3px solid #acaba4; color: #7c7c77; font-style: italic;">$1</blockquote>');
    }

    // Г. Поддержка разделительных линий ---
    if (processedText.trim() === '---') {
      processedText = '<hr style="border: 0; border-top: 1px solid #e3e2dc; margin: 10px 0;">';
    }

    // 3. РЕНДЕРИНГ MARKDOWN ЧЕРЕЗ MARKED.JS С ПОДДЕРЖКОЙ СТАНДАРТА GFM (ЗАЧЕРКИВАНИЕ + КОД)
    let html = "";
    const parseOptions = { gfm: true, breaks: true };

    if (processedText.includes('\n')) {
      html = marked.parse(processedText, parseOptions);
    } else {
      html = marked.parse(processedText, parseOptions).trim().replace(/^<p>|<\/p>$/g, '');
    }

    // 4. ПОДДЕРЖКА ССЫЛОК НА БЛОКИ ((uuid)) — СВЕРХСТРОГАЯ ПРОВЕРКА ДЕФИСОВ
    html = html.replace(/\(\(([^)]+)\)\)/gi, function (match, innerContent) {
      let blockId = innerContent;
      let alias = null;
      if (innerContent.includes('|')) {
        const parts = innerContent.split('|');
        blockId = parts.shift().trim();
        alias = parts.pop().trim();
      }

      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(blockId)) {
        return match;
      }

      const linkedBlock = allCurrentDecryptedBlocks.find(b => b.id === blockId);
      if (linkedBlock) {
        return `<span class="block-ref" data-block-id="${blockId}">${alias ? alias : `"${linkedBlock.content}"`}</span>`;
      } else {
        return `<span class="block-ref-external" data-block-id="${blockId}" ${alias ? `data-alias="${alias}"` : ''}>${alias ? `${alias} (⏳)` : `((загрузка блока: ${blockId.substring(0,8)}...))` }</span>`;
      }
    });

    return html;
  } catch (error) {
    console.error("Ошибка парсинга Markdown:", error);
    return text;
  }
} // Функция parseMarkdown железобетонно закрывается здесь!

// 1. УНИВЕРСАЛЬНЫЙ МОБИЛЬНЫЙ ЭКСПОРТ (КОПИРОВАНИЕ БЭКАПА В БУФЕР)
function exportData() {
  const backup = { pages: [], blocks: [] };
  const transaction = db.transaction(["pages", "blocks"], "readonly");

  transaction.objectStore("pages").openCursor().onsuccess = function (event) {
    const cursor = event.target.result;
    if (cursor) { backup.pages.push(cursor.value); cursor.continue(); }
  };

  transaction.objectStore("blocks").openCursor().onsuccess = function (event) {
    const cursor = event.target.result;
    if (cursor) { backup.blocks.push(cursor.value); cursor.continue(); }
  };

  transaction.oncomplete = function () {
    const backupText = JSON.stringify(backup);

    // Копируем зашифрованную базу прямо в память телефона
    navigator.clipboard.writeText(backupText).then(function() {
      alert("🔐 Зашифрованная база данных успешно скопирована в буфер обмена!\n\nПросто вставьте этот текст в любой текстовый файл или отправьте себе в мессенджер для сохранения бэкапа.");
    }).catch(function() {
      // Если буфер обмена на телефоне заблокирован, выводим текст в окошко для ручного копирования
      prompt("Скопируйте этот текст бэкапа целиком:", backupText);
    });
  };
}
// Проводник для кнопки экспорта
document.getElementById("btn-export").addEventListener("click", exportData);


// 2. УНИВЕРСАЛЬНЫЙ МОБИЛЬНЫЙ ИМПОРТ (ИЗ ФАЙЛА ИЛИ ЧЕРЕЗ ТЕКСТ)
function importData() {
  // Спрашиваем пользователя, как ему удобнее загрузить бэкап
  const choice = confirm("Нажмите 'ОК', чтобы выбрать файл бэкапа .json (для ПК)\n\nНажмите 'Отмена', чтобы вставить скопированный текст бэкапа вручную (для телефона).");

  if (choice) {
    // Способ для ПК: выбор файла с диска
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json";
    fileInput.onchange = function (event) {
      const file = event.target.files[0]; // Наш мобильный нолик на месте!
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (e) { executeImportJson(e.target.result); };
      reader.readAsText(file);
    };
    fileInput.click();
  } else {
    // Способ для смартфона: вставка текста из памяти телефона
    const userData = prompt("Вставьте сюда скопированный ранее текст зашифрованного бэкапа:");
    if (userData && userData.trim() !== "") {
      executeImportJson(userData);
    }
  }
}
// Проводник для кнопки импорта
document.getElementById("btn-import").addEventListener("click", importData);


// БРОНЕБОЙНЫЙ И БЕЗОПАСНЫЙ ИМПОРТ БАЗЫ ДАННЫХ
async function executeImportJson(jsonString) {
  try {
    const data = JSON.parse(jsonString);

    // Проверка 1: Проверяем базовое наличие нужных таблиц в файле
    if (!data.pages || !data.blocks || !Array.isArray(data.pages) || !Array.isArray(data.blocks)) {
      alert("❌ Ошибка: Выбранный файл не является резервной копией Logbook!");
      return;
    }

    // Проверка 2: Если база в файле не пустая, проверяем совместимость ключа шифрования
    if (data.pages.length > 0) {
      const testPage = data.pages[0];
      const testResult = await decryptText(testPage.title);

      // Если вместо нормального текста вернулась заглушка ошибки, значит пароль не подходит
      if (testResult === "⚠️ [Ошибка расшифровки данных]") {
        alert("❌ Критическая ошибка: Этот бэкап зашифрован другим мастер-паролем!\n\nИмпорт отменен. Чтобы загрузить эту базу, сначала перезапустите приложение и введите тот пароль, с которым создавался этот бэкап.");
        return;
      }
    }

    // Проверка 3: Если всё чисто, запускаем безопасную перезапись базы данных
    const transaction = db.transaction(["pages", "blocks"], "readwrite");

    // Очищаем старые таблицы только ПОСЛЕ успешных проверок выше
    transaction.objectStore("pages").clear();
    transaction.objectStore("blocks").clear();

    // Заливаем новые данные
    data.pages.forEach(p => transaction.objectStore("pages").add(p));
    data.blocks.forEach(b => transaction.objectStore("blocks").add(b));

    transaction.oncomplete = function () {
      alert("🎉 Резервная копия успешно проверена и загружена! Ваше приложение обновлено.");
      initApp();
    };

    transaction.onerror = function(e) {
      alert("❌ Системная ошибка IndexedDB при записи данных. Изменения отменены.");
    };

  } catch (err) {
    alert("❌ Не удалось прочитать данные. Убедитесь, что файл не поврежден и текст бэкапа скопирован полностью.");
  }
}


// Адаптивное управление сайдбаром (ПК + Мобилка)
const btnMenu = document.getElementById("btn-menu");
const sidebar = document.querySelector(".sidebar");
const overlay = document.getElementById("sidebar-overlay");

if (btnMenu && sidebar && overlay) {
  btnMenu.addEventListener("click", function() {
    if (window.innerWidth <= 768) {
      sidebar.classList.toggle("mobile-open");
      overlay.classList.toggle("mobile-open");
    } else {
      sidebar.classList.toggle("collapsed");
    }
  });
  overlay.addEventListener("click", function() {
    sidebar.classList.remove("mobile-open");
    overlay.classList.remove("mobile-open");
  });
}

// === КРИПТОГРАФИЧЕСКОЕ ЯДРО (WEB CRYPTO API) ===
async function deriveKey(password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  const salt = enc.encode("logbook-salt-12345");
  return await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function encryptText(plainText) {
  if (!cryptoKey || !plainText || plainText.trim() === "") return plainText || "";
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, cryptoKey, enc.encode(plainText));
  const resultBuffer = new Uint8Array(iv.length + encryptedBuffer.byteLength);
  resultBuffer.set(iv);
  resultBuffer.set(new Uint8Array(encryptedBuffer), iv.length);
  return Array.from(resultBuffer).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function decryptText(hexText) {
  if (!cryptoKey || !hexText || hexText.trim() === "" || hexText === "&nbsp;") return hexText;
  try {
    const combinedBuffer = new Uint8Array(hexText.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const iv = combinedBuffer.slice(0, 12);
    const encryptedData = combinedBuffer.slice(12);
    const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, cryptoKey, encryptedData);
    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) { return "⚠️ [Ошибка расшифровки данных]"; }
}

// Замок пароля и разблокировка интерфейса
document.getElementById("btn-unlock").addEventListener("click", async function() {
  const passwordInput = document.getElementById("master-password-input");
  const password = passwordInput.value;
  if (password.trim() === "") return;
  try {
    cryptoKey = await deriveKey(password);
    const transaction = db.transaction(["settings"], "readwrite");
    const store = transaction.objectStore("settings");
    const getRequest = store.get("auth_check");
    getRequest.onsuccess = async function(event) {
      const record = event.target.result;
      if (!record) {
        if (confirm("Использовать как новый мастер-пароль?")) {
          const encryptedSecret = await encryptText("LOGBOOK_ACCESS_GRANTED");
          const saveTx = db.transaction(["settings"], "readwrite");
          saveTx.objectStore("settings").add({ key: "auth_check", value: encryptedSecret });
          saveTx.oncomplete = async function() {
            document.getElementById("lock-screen").style.display = "none";
            await initApp();
          };
        } else { cryptoKey = null; }
      } else {
        if ((await decryptText(record.value)) === "LOGBOOK_ACCESS_GRANTED") {
          document.getElementById("lock-screen").style.display = "none";
          passwordInput.value = "";
          await initApp();
        } else { cryptoKey = null; alert("❌ Неверный пароль!"); }
      }
    };
  } catch (e) { cryptoKey = null; }
});

document.getElementById("master-password-input").addEventListener("keypress", function(e) {
  if (e.key === "Enter") document.getElementById("btn-unlock").click();
});

// Навигация и автоматическое создание скрытых заметок
async function checkAndCreatePage(pageName, type = "page") {
  const transaction = db.transaction(["pages"], "readwrite");
  const store = transaction.objectStore("pages");
  let foundPage = null;
  store.openCursor().onsuccess = async function(event) {
    const cursor = event.target.result;
    if (cursor) {
      if ((await decryptText(cursor.value.title)).toLowerCase() === pageName.toLowerCase()) { foundPage = cursor.value; }
      cursor.continue();
    } else {

      // ФИНАЛЬНЫЙ ВAРИAНТ: Считываем тип строго из паспорта страницы в базе данных
      if (foundPage) {
        document.getElementById("page-title").innerText = pageName;
        currentPageUUID = foundPage.id;

        // 1. Проверяем честный тип страницы, который записан в базе данных, или знак хэштега
        const isTargetATag = (foundPage.type && foundPage.type.trim() === "tag") || pageName.startsWith("#");

        // 2. Если это обычная заметка (НЕ тег и НЕ журнал с типом tag), заносим её в "Последние"
        if (!isTargetATag) {
          if (!recentPages.includes(foundPage.id)) {
            recentPages.unshift(foundPage.id);
            if (recentPages.length > 5) recentPages.pop();
          } else {
            recentPages = recentPages.filter(id => id !== foundPage.id);
            recentPages.unshift(foundPage.id);
          }
        }

        loadBlocks();
        loadPagesList();
      } else {
        const encryptedTitle = await encryptText(pageName);
        const newPage = { id: crypto.randomUUID(), title: encryptedTitle, type: type };
        const writeTx = db.transaction(["pages"], "readwrite");
        writeTx.objectStore("pages").add(newPage);
        writeTx.oncomplete = async function() {
          document.getElementById("page-title").innerText = pageName;
          currentPageUUID = newPage.id;
          const firstBlock = { id: crypto.randomUUID(), pageId: currentPageUUID, content: await encryptText(""), level: 0, order: Date.now() };
          const blockTx = db.transaction(["blocks"], "readwrite");
          blockTx.objectStore("blocks").add(firstBlock);
          blockTx.oncomplete = function() { loadPagesList(); loadBlocks(); };
        };
      }
    }
  };
}

// Клик по пустому фону редактора (ИСПРАВЛЕНО!)
// Клик по пустому фону редактора (ПОЛНОСТЬЮ ИСПРАВЛЕНО ДЛЯ НИЖНЕЙ ПАНЕЛИ)
document.getElementById("editor").addEventListener("click", async function(e) {
  // Если клик произошел внутри нижней панели инструментов, СРАЗУ выходим и ничего не ломаем!
  if (e.target.closest("#wysiwyg-toolbar")) return;

  const isContainerClick = e.target.id === "editor" || e.target.id === "blocks-list";
  if (isContainerClick) {
    document.querySelectorAll("#blocks-list li").forEach(el => el.classList.remove("selected-node"));
    const blockListElement = document.getElementById("blocks-list");
    if (blockListElement.children.length === 0) {
      if (!currentPageUUID) return;
      const firstBlock = { id: crypto.randomUUID(), pageId: currentPageUUID, content: await encryptText(""), level: 0, order: Date.now() };
      activeBlockId = firstBlock.id;
      const transaction = db.transaction(["blocks"], "readwrite");
      transaction.objectStore("blocks").add(firstBlock);
      transaction.oncomplete = function() { loadBlocks(); };
    } else {
      const textSpans = document.querySelectorAll("#blocks-list span");
      if (textSpans.length > 0) {
        const lastSpan = textSpans[textSpans.length - 1];
        lastSpan.dispatchEvent(new Event('click', { bubbles: true }));
      }
    }
  }
});

//document.getElementById("btn-focus-out").addEventListener("click", function() { focusedBlockId = null; loadBlocks(); });

// Асинхронное считывание внешних блоков с гарантированным отчетом о завершении
async function resolveExternalBlockReferences(onCompleteCallback) {
  const externalRefs = document.querySelectorAll(".block-ref-external");
  if (externalRefs.length === 0) {
    // Если внешних ссылок на странице нет, сразу даем добро на запуск скролла
    if (typeof onCompleteCallback === 'function') onCompleteCallback();
    return;
  }

  const transaction = db.transaction(["blocks"], "readonly");
  const store = transaction.objectStore("blocks");

  for (const element of externalRefs) {
    const blockId = element.getAttribute("data-block-id");
    try {
      const blockData = await new Promise((resolve, reject) => {
        const req = store.get(blockId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (blockData) {
        const decryptedContent = await decryptText(blockData.content);
        const hasAlias = element.getAttribute("data-alias");
        element.className = "block-ref";
        element.style.cssText = "";
        element.innerHTML = hasAlias ? hasAlias : `"${decryptedContent}"`;
        if (!allCurrentDecryptedBlocks.some(b => b.id === blockId)) {
          allCurrentDecryptedBlocks.push({ id: blockId, content: decryptedContent, pageId: blockData.pageId });
        }
      } else { element.innerHTML = `⚠️ [Блок не найден]`; }
    } catch (err) {}
  }

  // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Все внешние блоки заменены, высота страницы зафиксирована. Включаем скролл!
  if (typeof onCompleteCallback === 'function') {
    onCompleteCallback();
  }
}


// ПРИВЯЗКА КНОПОК ПАНЕЛИ ИНСТРУМЕНТОВ К ФУНКЦИЯМ СДВИГА И ПЕРЕМЕЩЕНИЯ
window.addEventListener("DOMContentLoaded", function () {
  // РЕДАКТИРОВАНИЕ ЗАГОЛОВКА СТРАНИЦЫ С ОБНОВЛЕНИЕМ ССЫЛОК
  const pageTitle = document.getElementById("page-title");
  if (pageTitle) {
    pageTitle.style.cursor = "pointer";
    pageTitle.title = "Кликните, чтобы переименовать страницу";

    pageTitle.addEventListener("click", async function () {
      if (!currentPageUUID) return;

      const tx = db.transaction(["pages"], "readonly");
      const pageData = await new Promise(r => {
        tx.objectStore("pages").get(currentPageUUID).onsuccess = (e) => r(e.target.result);
      });

      if (pageData && pageData.type === "journal") {
        alert("Название страницы Журнала изменить нельзя, так как оно привязано к дате календаря!");
        return;
      }

      const oldName = pageTitle.innerText.trim();
      const newName = prompt("Введите новое название для этой страницы:", oldName);

      if (newName && newName.trim() !== "" && newName.trim() !== oldName) {
        const cleanNewName = newName.trim();

        // 1. Обновляем имя самой страницы в таблице 'pages'
        const updateTx = db.transaction(["pages"], "readwrite");
        const encryptedNewTitle = await encryptText(cleanNewName);
        pageData.title = encryptedNewTitle;
        updateTx.objectStore("pages").put(pageData);

        updateTx.oncomplete = async function () {
          console.log(`Страница переименована в: ${cleanNewName}. Запускаем конвейер обновления связей...`);

          const rawBlocksList = [];
          const blocksTx = db.transaction(["blocks"], "readonly");

          // Шаг А: Быстро собираем абсолютно все блоки из базы в массив памяти
          blocksTx.objectStore("blocks").openCursor().onsuccess = function (event) {
            const cursor = event.target.result;
            if (cursor) {
              rawBlocksList.push(cursor.value);
              cursor.continue();
            } else {
              // Шаг Б: Когда все блоки в памяти, запускаем асинхронную расшифровку и замену
              processAndStoreUpdatedLinks(rawBlocksList, oldName, cleanNewName);
            }
          };
        };
      }
    });
  }

  // Вставляю твой фрагмент сюда???

  function getActiveEditorData() {
    if (!currentlyEditingBlock) return null;
    return currentlyEditingBlock;
  }

  // Вспомогательная функция для ювелирной замены старых ссылок на новые по всей базе
  async function processAndStoreUpdatedLinks(allBlocks, oldName, newName) {
    let updatedCount = 0;
    const targetPattern = "[[" + oldName + "]]";
    const targetAliasPattern = "[[" + oldName + "|";

    for (let block of allBlocks) {
      const decryptedContent = await decryptText(block.content);

      if (decryptedContent.includes(targetPattern) || decryptedContent.includes(targetAliasPattern)) {
        let updatedContent = decryptedContent;
        updatedContent = updatedContent.split(targetPattern).join("[[" + newName + "]]");
        updatedContent = updatedContent.split(targetAliasPattern).join("[[" + newName + "|");

        block.content = await encryptText(updatedContent);
        updatedCount++;
      }
    }

    if (updatedCount > 0) {
      const writeTx = db.transaction(["blocks"], "readwrite");
      const store = writeTx.objectStore("blocks");
      for (let block of allBlocks) { store.put(block); }
      writeTx.oncomplete = function () { finalizePageRename(newName); };
    } else {
      finalizePageRename(newName);
    }
  }

  // Завершающий этап обновления интерфейса
  function finalizePageRename(cleanNewName) {
    document.getElementById("page-title").innerText = cleanNewName;
    loadPagesList();
    loadBlocks();
    alert("Страница переименована! Перекрестные вики-ссылки успешно обновлены.");
  }

  // ОБНОВЛЕННАЯ СИСТЕМА ПРИВЯЗКИ КНОПОК ПАНЕЛИ ДЛЯ ПК И АНДРОИД
  // ОРИГИНАЛЬНАЯ РАБОЧАЯ ФУНКЦИЯ ДЛЯ ПК
  // ПОЛНОСТЬЮ ИСПРАВЛЕННАЯ СИСТЕМА ПРИВЯЗКИ КНОПОК ПАНЕЛИ
  function bindToolbarButton(id, callback) {
    const element = document.getElementById(id);
    if (!element) return;

    // 1. Создаем внутреннюю функцию для запуска действия кнопки
    const runAction = function (e) {
      // Кнопке переноса строки НЕ ЗАПРЕЩАЕМ фокус, чтобы работала клавиатура
      if (id !== "btn-toolbar-newline") {
        e.preventDefault();
      }
      e.stopPropagation();
      callback(e);
    };

    // 2. Блокируем потерю фокуса при клике мышкой на ПК
    element.addEventListener("mousedown", function (e) {
      if (id !== "btn-toolbar-newline") e.preventDefault();
    });

    // 3. Обрабатываем касания пальцем на Android
    element.addEventListener("touchstart", function (e) {
      if (id !== "btn-toolbar-newline") e.preventDefault();
      runAction(e);
    }, { passive: false });

    // 4. Оставляем стандартный клик (как запасной вариант для ПК)
    element.addEventListener("click", runAction);
  } // Вот теперь функция закрывается строго здесь!

  // ЛОГИКА СВОРAЧИВАНИЯ РАЗДЕЛОВ САЙДБАРА
  const sectionHeaders = ["header-recent", "header-journals", "header-notes", "header-tags"];
  sectionHeaders.forEach(id => {
    const header = document.getElementById(id);
    if (header) {
      header.addEventListener("click", function () {
        // Находим родительский контейнер раздела и переключаем ему класс collapsed-section
        const section = header.closest(".sidebar-section");
        if (section) {
          section.classList.toggle("collapsed-section");
        }
      });
    }
  });

  // === ЛOГИКA КНOПOК НАВИГАЦИИ (НАЗАД / ВПЕРЕД) ===
  const btnNavBack = document.getElementById("btn-nav-back");
  const btnNavForward = document.getElementById("btn-nav-forward");

  if (btnNavBack && btnNavForward) {
    btnNavBack.addEventListener("click", function(e) {
      e.preventDefault();
      e.stopPropagation();
      if (navigationHistoryBack.length > 1) {
        isNavigatingViaButtons = true;
        const currentPage = navigationHistoryBack.shift();
        navigationHistoryForward.unshift(currentPage);
        const previousPageId = navigationHistoryBack[0];
        const tx = db.transaction(["pages"], "readonly");
        tx.objectStore("pages").get(previousPageId).onsuccess = async function(event) {
          const pageData = event.target.result;
          if (pageData) {
            document.getElementById("page-title").innerText = await decryptText(pageData.title);
            currentPageUUID = pageData.id;
            focusedBlockId = null;
            loadBlocks();
            loadPagesList();
          }
          isNavigatingViaButtons = false;
        };
      }
    });

    // Сюда вариант А

    btnNavForward.addEventListener("click", function(e) {
      e.preventDefault();
      e.stopPropagation();
      if (navigationHistoryForward.length > 0) {
        isNavigatingViaButtons = true;
        const nextPageId = navigationHistoryForward.shift();
        navigationHistoryBack.unshift(nextPageId);
        const tx = db.transaction(["pages"], "readonly");
        tx.objectStore("pages").get(nextPageId).onsuccess = async function(event) {
          const pageData = event.target.result;
          if (pageData) {
            document.getElementById("page-title").innerText = await decryptText(pageData.title);
            currentPageUUID = pageData.id;
            focusedBlockId = null;
            loadBlocks();
            loadPagesList();
          }
          isNavigatingViaButtons = false;
        };
      }
    });
  }

  // === УМНОЕ ГЛОБАЛЬНОЕ СВОРAЧИВАНИЕ / РAЗВЕРТЫВАНИЕ ВСЕХ БЛОКОВ ===
  const btnToggleAll = document.getElementById("btn-toggle-all");
  if (btnToggleAll) {
    btnToggleAll.addEventListener("click", async function(e) {
      e.preventDefault();
      e.stopPropagation();

      // Проверяем, есть ли вообще блоки на этой странице
      if (!allCurrentDecryptedBlocks || allCurrentDecryptedBlocks.length === 0) return;

      // Определяем текущее состояние: есть ли на странице хоть один РАЗВЕРНУТЫЙ блок?
      const hasExpandedBlocks = allCurrentDecryptedBlocks.some(b => !b.isCollapsed);
      const targetState = hasExpandedBlocks;

      // 1. Просто меняем флаг свернутости у всех блоков в памяти приложения
      for (let block of allCurrentDecryptedBlocks) {
        block.isCollapsed = targetState;
      }

      // 2. Отдаем массив нашей функции: она пересчитает индексы порядка (10, 20...), зашифрует и сохранит всё в базу
      await reorderAndSaveBlocks(allCurrentDecryptedBlocks);

      // 3. Плавно обновляем экран
      requestAnimationFrame(function() {
        loadBlocks();
      });
    });
  }
  // =================================================================

  bindToolbarButton("btn-toolbar-left", async function (e) {
    e.preventDefault(); const data = getActiveEditorData(); if (!data) return;
    if (data.block.level === undefined) data.block.level = 0;
    if (data.block.level > 0) { data.block.level--; await reorderAndSaveBlocks(data.pageBlocks); activeBlockId = data.block.id; loadBlocks(); }
  });

  bindToolbarButton("btn-toolbar-right", async function (e) {
    e.preventDefault(); const data = getActiveEditorData(); if (!data) return;
    if (data.block.level === undefined) data.block.level = 0;
    if (data.index > 0) {
      const prev = data.pageBlocks[data.index - 1];
      if (data.block.level <= (prev.level || 0)) { data.block.level++; await reorderAndSaveBlocks(data.pageBlocks); activeBlockId = data.block.id; loadBlocks(); }
    }
  });

  bindToolbarButton("btn-toolbar-up", async function (e) {
    e.preventDefault(); const data = getActiveEditorData(); if (!data) return;
    const currentLevel = data.block.level || 0;
    const ourBranch = [data.block];
    for (let i = data.index + 1; i < data.pageBlocks.length; i++) {
      if ((data.pageBlocks[i].level || 0) > currentLevel) ourBranch.push(data.pageBlocks[i]); else break;
    }
    let neighborIndex = -1;
    for (let i = data.index - 1; i >= 0; i--) {
      if ((data.pageBlocks[i].level || 0) === currentLevel) { neighborIndex = i; break; }
      if ((data.pageBlocks[i].level || 0) < currentLevel) break;
    }
    if (neighborIndex !== -1) {
      let neighborBranch = [];
      for (let i = neighborIndex; i < data.index; i++) {
        if (i === neighborIndex || (data.pageBlocks[i].level || 0) > currentLevel) neighborBranch.push(data.pageBlocks[i]); else break;
      }
      let newOrder = [...data.pageBlocks].filter(b => !ourBranch.includes(b) && !neighborBranch.includes(b));
      newOrder.splice(neighborIndex, 0, ...ourBranch, ...neighborBranch);

      // ИСПРАВЛЕНИЕ: Убрали ручной пересчет * 10. Наша функция сохранения сама всё сделает!
      await reorderAndSaveBlocks(newOrder); activeBlockId = data.block.id; loadBlocks();
    }
  });

  bindToolbarButton("btn-toolbar-down", async function (e) {
    e.preventDefault(); const data = getActiveEditorData(); if (!data) return;
    const currentLevel = data.block.level || 0;
    const ourBranch = [data.block];
    for (let i = data.index + 1; i < data.pageBlocks.length; i++) {
      if ((data.pageBlocks[i].level || 0) > currentLevel) ourBranch.push(data.pageBlocks[i]); else break;
    }
    const nextIndex = data.index + ourBranch.length;
    if (nextIndex < data.pageBlocks.length && (data.pageBlocks[nextIndex].level || 0) === currentLevel) {
      let neighborBranch = [];
      for (let i = nextIndex; i < data.pageBlocks.length; i++) {
        if (i === nextIndex || (data.pageBlocks[i].level || 0) > currentLevel) neighborBranch.push(data.pageBlocks[i]); else break;
      }
      let newOrder = [...data.pageBlocks].filter(b => !ourBranch.includes(b) && !neighborBranch.includes(b));
      newOrder.splice(data.index, 0, ...neighborBranch, ...ourBranch);

      // ИСПРАВЛЕНИЕ: Убрали ручной пересчет * 10. Наша функция сохранения сама всё сделает!
      await reorderAndSaveBlocks(newOrder); activeBlockId = data.block.id; loadBlocks();
    }
  });

  // ========================================================
  //   АБСОЛЮТНО НАДЕЖНЫЕ ФУНКЦИИ ВСТАВКИ (С УЧЕТОМ СВЕРНУТЫХ ВЕТОК)
  // ========================================================
  window.toolbarInsertAbove = async function(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }

    // 1. Ищем выделенную строку на экране
    const selectedLi = document.querySelector("#blocks-list li.selected-node");
    if (!selectedLi) return;

    // Извлекаем честный UUID выделенного блока
    const targetBlockId = selectedLi.id.replace("li-block-", "");
    if (!targetBlockId) return;

    // 2. ВЫКАЧИВАЕМ АКТУАЛЬНЫЕ БЛОКИ СТРАНИЦЫ НАПРЯМУЮ ИЗ БАЗЫ (ЗАЩИТА ОТ ZOOM И СВЕРНУТЫХ ВЕТОК)
    const rawBlocks = [];
    const tx = db.transaction(["blocks"], "readonly");
    const store = tx.objectStore("blocks");

    store.openCursor().onsuccess = function(event) {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.pageId === currentPageUUID) { rawBlocks.push(cursor.value); }
        cursor.continue();
      }
    };

    tx.oncomplete = async function() {
      // Сортируем блоки из базы по их честному текущему порядку
      rawBlocks.sort((a, b) => (a.order || 0) - (b.order || 0));

      // Находим точный индекс выделенного блока в полном массиве базы
      const databaseIndex = rawBlocks.findIndex(b => b.id === targetBlockId);
      if (databaseIndex === -1) return;

      const targetBlock = rawBlocks[databaseIndex];
      const encryptedEmpty = await encryptText("");

      // Создаем новый блок на том же уровне вложенности
      const newBlock = {
        id: crypto.randomUUID(),
        pageId: currentPageUUID,
        content: encryptedEmpty,
        level: targetBlock.level !== undefined ? targetBlock.level : 0
      };

      // Вставляем строго перед целевым блоком в честном массиве
      rawBlocks.splice(databaseIndex, 0, newBlock);

      activeBlockId = newBlock.id;

      // Начисто перенумеровываем всю страницу (10, 20, 30...) и обновляем экран
      await reorderAndSaveBlocks(rawBlocks);
      loadBlocks();
    };
  };

  window.toolbarInsertBelow = async function(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }

    // 1. Ищем выделенную строку на экране
    const selectedLi = document.querySelector("#blocks-list li.selected-node");
    if (!selectedLi) return;

    const targetBlockId = selectedLi.id.replace("li-block-", "");
    if (!targetBlockId) return;

    // 2. ВЫКАЧИВАЕМ АКТУАЛЬНЫЕ БЛОКИ СТРАНИЦЫ НАПРЯМУЮ ИЗ БАЗЫ
    const rawBlocks = [];
    const tx = db.transaction(["blocks"], "readonly");
    const store = tx.objectStore("blocks");

    store.openCursor().onsuccess = function(event) {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.pageId === currentPageUUID) { rawBlocks.push(cursor.value); }
        cursor.continue();
      }
    };

    tx.oncomplete = async function() {
      rawBlocks.sort((a, b) => (a.order || 0) - (b.order || 0));

      const databaseIndex = rawBlocks.findIndex(b => b.id === targetBlockId);
      if (databaseIndex === -1) return;

      const targetBlock = rawBlocks[databaseIndex];
      const currentLevel = targetBlock.level !== undefined ? targetBlock.level : 0;

      // Ищем, где заканчивается ВСЯ ветка выделенного блока (включая скрытых и свернутых детей)
      let insertAt = databaseIndex + 1;
      for (let i = databaseIndex + 1; i < rawBlocks.length; i++) {
        if ((rawBlocks[i].level || 0) > currentLevel) insertAt++; else break;
      }

      const encryptedEmpty = await encryptText("");

      // Создаем новый блок на уровне родителя
      const newBlock = {
        id: crypto.randomUUID(),
        pageId: currentPageUUID,
        content: encryptedEmpty,
        level: currentLevel
      };

      // Вставляем строго после родительского блока и всей его вложенной ветки
      rawBlocks.splice(insertAt, 0, newBlock);

      activeBlockId = newBlock.id;

      // Начисто перенумеровываем всю страницу (10, 20, 30...) и обновляем экран
      await reorderAndSaveBlocks(rawBlocks);
      loadBlocks();
    };
  };

  bindToolbarButton("btn-toolbar-copy", function (e) {
    e.preventDefault(); const data = getActiveEditorData(); if (!data) return;
    navigator.clipboard.writeText("((" + data.block.id + "))").then(() => alert("Скопировано!"));
  });

  // МОБИЛЬНЫЙ БРОНЕБОЙНЫЙ ПЕРЕНОС СТРОКИ
  bindToolbarButton("btn-toolbar-newline", function (e) {
    e.preventDefault();
    e.stopPropagation();

    const selectedLi = document.querySelector("#blocks-list li.selected-node");
    let activeTextarea = selectedLi ? selectedLi.querySelector("textarea") : document.querySelector("#blocks-list textarea");

    if (activeTextarea) {
      activeTextarea.focus();

      const start = activeTextarea.selectionStart;
      const end = activeTextarea.selectionEnd;
      const text = activeTextarea.value;

      // Врезаем перенос строки \n прямо в текущее поле на экране
      activeTextarea.value = text.substring(0, start) + "\n" + text.substring(end);
      activeTextarea.selectionStart = activeTextarea.selectionEnd = start + 1;

      // Растягиваем поле ввода по высоте
      activeTextarea.style.height = "auto";
      activeTextarea.style.height = activeTextarea.scrollHeight + "px";

      // Запускаем автосохранение в базу
      activeTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });


  bindToolbarButton("btn-toolbar-delete", function (e) {
    e.preventDefault(); const data = getActiveEditorData(); if (!data) return;
    if (confirm("Удалить строку?")) {
      if (data.index > 0) activeBlockId = data.pageBlocks[data.index - 1].id;
      else if (data.pageBlocks.length > 1) activeBlockId = data.pageBlocks[data.index + 1].id;
      const tx = db.transaction(["blocks"], "readwrite");
      tx.objectStore("blocks").delete(data.block.id);
      tx.oncomplete = function () { loadBlocks(); };
    }
  });

  // СТАНЕТ (Поиск, адаптированный под новый сайдбар):
  // ДВИЖОК МГНОВЕННОГО ЛОКАЛЬНОГО ПОИСКА
  const searchInput = document.getElementById("search-input");
  const searchResultsList = document.getElementById("search-results");
  const sidebarSectionsContainer = document.querySelector(".sidebar-sections-container"); // Находим контейнер новых разделов

  if (searchInput && searchResultsList && sidebarSectionsContainer) {
    searchInput.addEventListener("input", async function() {
      const query = searchInput.value.trim().toLowerCase();

      // Если поле пустое — возвращаем стандартный сайдбар со всеми четырьмя разделами
      if (query === "") {
        searchResultsList.innerHTML = "";
        searchResultsList.style.display = "none";
        sidebarSectionsContainer.style.display = "block"; // Показываем новые разделы обратно
        return;
      }

      // Переключаем списки в режим поиска: прячем все разделы, включаем результаты поиска
      sidebarSectionsContainer.style.display = "none";
      searchResultsList.style.display = "block";
      searchResultsList.innerHTML = "<li class='search-no-results'>🔍 Ищем...</li>";

      try {
        // Шаг А: Выкачиваем ВСЕ страницы и ВСЕ блоки из IndexedDB в память
        const allPages = [], allBlocks = [];

        const tx = db.transaction(["pages", "blocks"], "readonly");

        tx.objectStore("pages").openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) { allPages.push(cursor.value); cursor.continue(); }
        };

        tx.objectStore("blocks").openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) { allBlocks.push(cursor.value); cursor.continue(); }
        };

        tx.oncomplete = async function () {
          // База закрылась, данные в памяти. Запускаем умную фильтрацию
          await executeLocalSearch(allPages, allBlocks, query);
        };
      } catch (err) {
        console.error("Ошибка при поиске:", err);
      }
    });
  }

  // Функция фильтрации, дешифровки и отрисовки результатов поиска
  async function executeLocalSearch(pages, blocks, query) {
    searchResultsList.innerHTML = "";
    let hasMatches = false;

    // Шаг 1: Ищем совпадения среди НАЗВАНИЙ СТРАНИЦ
    const matchedPages = [];
    for (let page of pages) {
      const decryptedTitle = await decryptText(page.title);
      if (decryptedTitle.toLowerCase().includes(query)) {
        matchedPages.push({ id: page.id, title: decryptedTitle });
      }
    }

    // Если нашли страницы по названию, выводим их в топ результатов
    if (matchedPages.length > 0) {
      hasMatches = true;
      const headerLi = document.createElement("li");
      headerLi.className = "search-page-header";
      headerLi.innerText = "Найденные страницы";
      searchResultsList.appendChild(headerLi);

      matchedPages.forEach(p => {
        const itemLi = document.createElement("li");
        itemLi.className = "search-block-item";
        itemLi.innerText = "📄 " + p.title;
        itemLi.addEventListener("click", function () {
          document.getElementById("page-title").innerText = p.title;
          currentPageUUID = p.id; focusedBlockId = null; searchInput.value = "";
          searchResultsList.style.display = "none";
          if (sidebarSectionsContainer) sidebarSectionsContainer.style.display = "block";
          loadBlocks();
        });
        searchResultsList.appendChild(itemLi);
      });
    }

    // Шаг 2: Ищем совпадения внутри СОДЕРЖИМОГО СТРОК (ИСПРАВЛЕНО И БЕЗОПАСНО!)
    const blocksByPage = {};

    // Бежим по всем зашифрованным блокам из памяти
    for (let i = 0; i < blocks.length; i++) {
      const currentRawBlock = blocks[i];

      try {
        // Честно дожидаемся расшифровки текста конкретного блока
        const clearText = await decryptText(currentRawBlock.content);

        // Если текст расшифрован и в нем есть искомое слово
        if (clearText && clearText.toLowerCase().includes(query)) {
          if (!blocksByPage[currentRawBlock.pageId]) {
            blocksByPage[currentRawBlock.pageId] = [];
          }
          // Сохраняем расшифрованный текст для вывода красивого превью в поиске
          blocksByPage[currentRawBlock.pageId].push({
            id: currentRawBlock.id,
            content: clearText
          });
        }
      } catch (cryptoErr) {
        console.error("Пропуск блока при поиске (ошибка ключа):", cryptoErr);
      }
    }


    // Выводим найденные строки с разбивкой по страницам
    for (let pageId in blocksByPage) {
      hasMatches = true;

      // Ищем саму страницу в массиве, чтобы узнать её человеческое имя
      const pageObj = pages.find(p => p.id === pageId);
      const pageTitleText = pageObj ? await decryptText(pageObj.title) : "Неизвестная заметка";

      const pageHeaderLi = document.createElement("li");
      pageHeaderLi.className = "search-page-header";
      pageHeaderLi.innerText = "Внутри: " + pageTitleText;
      searchResultsList.appendChild(pageHeaderLi);

      blocksByPage[pageId].forEach(b => {
        const blockLi = document.createElement("li");
        blockLi.className = "search-block-item";
        // Очищаем текст от Markdown-разметки для красивого превью в поиске
        blockLi.innerText = b.content.replace(/[#*`[\]()|]/g, "");

        // Клик по строке переносит прямо внутрь этой заметки с фокусом на блок!
        // СТАНЕТ:
        blockLi.addEventListener("click", function() {
          focusedBlockId = null; // Отключаем уродский Zoom
          window.anchorBlockId = b.id; // Включаем красивый якорный фокус!
          setTimeout(window.highlightAnchorBlock, 250);
          searchInput.value = "";
          if(sidebarSectionsContainer) sidebarSectionsContainer.style.display = "block";
          searchResultsList.style.display = "none";

          // Открываем страницу через главный конвейер навигации
          checkAndCreatePage(pageTitleText, "page");
        });

        searchResultsList.appendChild(blockLi);
      });
    }

    // Если вообще ничего не нашли в поиске
    if (!hasMatches) {
      searchResultsList.innerHTML = "<li class='search-no-results'>Ничего не найдено 🤷‍♂️</li>";
    }
  }

  // ========================================================
  //   ЮВЕЛИРНАЯ СИСТЕМA ЯКОРНОГО СKPОЛЛA И ПОДСВЕТКИ СТРОК (ЧИСТОВИК)
  // ========================================================
  window.highlightAnchorBlock = function() {
    if (!window.anchorBlockId || window.anchorBlockId === "null" || window.anchorBlockId === null) {
      return;
    }

    let attempts = 0;
    const currentAnchorId = window.anchorBlockId;
    window.anchorBlockId = null;

    const checkExist = setInterval(function() {
      attempts++;

      const targetLi = document.getElementById("li-block-" + currentAnchorId);
      const container = document.querySelector(".main-content");

      if (targetLi && container) {
        clearInterval(checkExist);

        // Мягкая пауза 100мс, чтобы вёрстка страницы окончательно замерла
        setTimeout(function() {
          const targetRect = targetLi.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();

          const bias = targetRect.top - containerRect.top - (container.clientHeight / 2) + (targetRect.height / 2);
          const targetScrollTop = container.scrollTop + bias;

          // Очищаем старые следы подсветки перед запуском
          document.querySelectorAll("#blocks-list li").forEach(el => el.classList.remove("anchor-highlight"));

          // Плавно центрируем строку на экране
          container.scrollTo({
            top: Math.max(0, targetScrollTop),
            behavior: "smooth"
          });

          // Включаем исправленную вспышку
          targetLi.classList.add("anchor-highlight");

          // Чисто убираем класс через 2 секунды
          setTimeout(function() {
            targetLi.classList.remove("anchor-highlight");
          }, 2000);

        }, 100);

      } else if (attempts > 40) {
        clearInterval(checkExist);
      }
    }, 50);
  };

  // ========================================================
  //   ГЛОБАЛЬНЫЕ ГОРЯЧИЕ КЛАВИШИ ДЛЯ ПК (УПРАВЛЕНИЕ ВЫДЕЛЕННОЙ СТРОКОЙ)
  // ========================================================
  window.addEventListener("keydown", async function(e) {
    if (document.activeElement.tagName === "TEXTAREA") return;

    const selectedLi = document.querySelector("#blocks-list li.selected-node");
    if (!selectedLi || !allCurrentDecryptedBlocks || allCurrentDecryptedBlocks.length === 0) return;
    if (!currentlyEditingBlock || !currentlyEditingBlock.block) return;

    const targetId = currentlyEditingBlock.block.id;
    const memoryIndex = allCurrentDecryptedBlocks.findIndex(b => b.id === targetId);
    if (memoryIndex === -1) return;

    const currentBlock = allCurrentDecryptedBlocks[memoryIndex];
    const data = {
      block: currentBlock,
      index: memoryIndex,
      pageBlocks: allCurrentDecryptedBlocks
    };

    // === КОМАНДА 1: СДВИГ ВПРАВО (КЛАВИША TAB) ===
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      if (data.block.level === undefined) data.block.level = 0;
      if (data.index > 0) {
        const prev = data.pageBlocks[data.index - 1];
        if (data.block.level <= (prev.level || 0)) {
          data.block.level++;
          await reorderAndSaveBlocks(data.pageBlocks);
          activeBlockId = data.block.id;
          loadBlocks();
        }
      }
    }

    // === КОМАНДА 2: СДВИГ ВЛЕВО (КЛАВИШИ SHIFT + TAB) ===
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      if (data.block.level === undefined) data.block.level = 0;
      if (data.block.level > 0) {
        data.block.level--;
        await reorderAndSaveBlocks(data.pageBlocks);
        activeBlockId = data.block.id;
        loadBlocks();
      }
    }

    // === КОМАНДА 3: ПЕРЕМЕСТИТЬ ВЕТКУ ВЫШЕ (ALT + SHIFT + СТРЕЛКА ВВЕРХ) ===
    if (e.key === "ArrowUp" && e.altKey && e.shiftKey) {
      e.preventDefault();
      const currentLevel = data.block.level || 0;
      const ourBranch = [data.block];
      for (let i = data.index + 1; i < data.pageBlocks.length; i++) {
        if ((data.pageBlocks[i].level || 0) > currentLevel) ourBranch.push(data.pageBlocks[i]); else break;
      }
      let neighborIndex = -1;
      for (let i = data.index - 1; i >= 0; i--) {
        if ((data.pageBlocks[i].level || 0) === currentLevel) { neighborIndex = i; break; }
        if ((data.pageBlocks[i].level || 0) < currentLevel) break;
      }
      if (neighborIndex !== -1) {
        let neighborBranch = [];
        for (let i = neighborIndex; i < data.index; i++) {
          if (i === neighborIndex || (data.pageBlocks[i].level || 0) > currentLevel) neighborBranch.push(data.pageBlocks[i]); else break;
        }
        let newOrder = [...data.pageBlocks].filter(b => !ourBranch.includes(b) && !neighborBranch.includes(b));
        newOrder.splice(neighborIndex, 0, ...ourBranch, ...neighborBranch);

        // ИСПРАВЛЕНИЕ: Убрали ручной пересчет порядка веток. reorderAndSaveBlocks сделает это идеально.
        await reorderAndSaveBlocks(newOrder); activeBlockId = data.block.id; loadBlocks();
      }
    }

    // === КОМАНДА 4: ПЕРЕМЕСТИТЬ ВЕТКУ НИЖЕ (ALT + SHIFT + СТРЕЛКА ВНИЗ) ===
    if (e.key === "ArrowDown" && e.altKey && e.shiftKey) {
      e.preventDefault();
      const currentLevel = data.block.level || 0;
      const ourBranch = [data.block];
      for (let i = data.index + 1; i < data.pageBlocks.length; i++) {
        if ((data.pageBlocks[i].level || 0) > currentLevel) ourBranch.push(data.pageBlocks[i]); else break;
      }
      const nextIndex = data.index + ourBranch.length;
      if (nextIndex < data.pageBlocks.length && (data.pageBlocks[nextIndex].level || 0) === currentLevel) {
        let neighborBranch = [];
        for (let i = nextIndex; i < data.pageBlocks.length; i++) {
          if (i === nextIndex || (data.pageBlocks[i].level || 0) > currentLevel) neighborBranch.push(data.pageBlocks[i]); else break;
        }
        let newOrder = [...data.pageBlocks].filter(b => !ourBranch.includes(b) && !neighborBranch.includes(b));
        newOrder.splice(data.index, 0, ...neighborBranch, ...ourBranch);

        // ИСПРАВЛЕНИЕ: Убрали ручной пересчет порядка веток. reorderAndSaveBlocks сделает это идеально.
        await reorderAndSaveBlocks(newOrder); activeBlockId = data.block.id; loadBlocks();
      }
    }

    // === КОМАНДА 5: УДАЛИТЬ СТРОКУ (CTRL + DELETE) ===
    if (e.key === "Delete" && e.ctrlKey) {
      e.preventDefault();
      if (confirm("Удалить строку?")) {
        if (data.index > 0) activeBlockId = data.pageBlocks[data.index - 1].id;
        else if (data.pageBlocks.length > 1) activeBlockId = data.pageBlocks[data.index + 1].id;
        const tx = db.transaction(["blocks"], "readwrite");
        tx.objectStore("blocks").delete(data.block.id);
        tx.oncomplete = function () { loadBlocks(); };
      }
    }

    // === КОМАНДА 6: ВСТАВИТЬ ПУСТУЮ СТРОКУ СВЕРХY (SHIFT + ENTER) ===
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      // ИСПРАВЛЕНИЕ: Убрали order: 0
      const newBlock = { id: crypto.randomUUID(), pageId: currentPageUUID, content: "", level: data.block.level || 0 };
      let newOrder = [...data.pageBlocks];
      newOrder.splice(data.index, 0, newBlock);
      await reorderAndSaveBlocks(newOrder);
      activeBlockId = newBlock.id;
      loadBlocks();
    }

    // === КОМАНДА 7: ВСТАВИТЬ ПУСТУЮ СТРОКУ СНИЗY (ПРОСТО ENTER) ===
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const currentLevel = data.block.level || 0;
      let insertAt = data.index + 1;
      for (let i = data.index + 1; i < data.pageBlocks.length; i++) {
        if ((data.pageBlocks[i].level || 0) > currentLevel) insertAt++; else break;
      }
      // ИСПРАВЛЕНИЕ: Убрали order: 0
      const newBlock = { id: crypto.randomUUID(), pageId: currentPageUUID, content: "", level: currentLevel };
      let newOrder = [...data.pageBlocks];
      newOrder.splice(insertAt, 0, newBlock);
      await reorderAndSaveBlocks(newOrder);
      activeBlockId = newBlock.id;
      loadBlocks();
    }
  });

  // АВТО-ЗАКРЫТИЕ КОНТЕКСТНОГО МЕНЮ ПРИ КЛИКЕ В ЛЮБОЕ ДРУГОЕ МЕСТО
  window.addEventListener("click", function(e) {
    const menu = document.getElementById("context-menu");
    if (menu && menu.style.display === "block") {
      if (!e.target.closest("#context-menu")) {
        menu.style.display = "none";
      }
    }
  });

}); // Финальное закрытие DOMContentLoaded
