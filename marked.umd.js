/**
 * Автономный мини-парсер Markdown (marked-compat-umd)
 * Поддерживает таблицы, жирный, курсив и списки.
 */
(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.marked = {}));
})(this, (function (exports) { 'use strict';

    function parse(md) {
        if (!md) return '';
        let html = '';
        let lines = md.split('\n');
        let inTable = false;
        let tableRows = [];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();

            // Обработка таблиц Markdown
            if (line.startsWith('|') && line.endsWith('|')) {
                if (line.includes('---') || line.includes('- -')) {
                    continue; // Пропускаем разделитель таблицы
                }
                inTable = true;
                let cells = line.split('|').map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
                tableRows.push(cells);
                continue;
            } else {
                if (inTable) {
                    html += renderTable(tableRows);
                    tableRows = [];
                    inTable = false;
                }
            }

            // Обычный инлайн-парсер текста
            html += parseInline(lines[i]) + '\n';
        }

        if (inTable) {
            html += renderTable(tableRows);
        }

        return html;
    }

    function parseInline(text) {
        if (!text) return '';
        let html = text;

        // Жирный текст
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');

        // Курсив
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        html = html.replace(/_(.*?)_/g, '<em>$1</em>');

        // Внешние ссылки вида [Текст](https://...)
        html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');

        return html;
    }

    function renderTable(rows) {
        if (rows.length === 0) return '';
        let html = '<table>';

        // Заголовок
        html += '<thead><tr>';
        rows[0].forEach(cell => {
            html += `<th>${parseInline(cell)}</th>`;
        });
        html += '</tr></thead>';

        // Тело таблицы
        if (rows.length > 1) {
            html += '<tbody>';
            for (let i = 1; i < rows.length; i++) {
                html += '<tr>';
                rows[i].forEach(cell => {
                    html += `<td>${parseInline(cell)}</td>`;
                });
                html += '</tr>';
            }
            html += '</tbody>';
        }

        html += '</table>';
        return html;
    }

    exports.parse = parse;
    exports.parseInline = parseInline;

    Object.defineProperty(exports, '__esModule', { value: true });

}));
