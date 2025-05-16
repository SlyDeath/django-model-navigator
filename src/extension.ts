import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface ModelField {
    name: string;
    type: string;
    relatedModel?: string;
    relatedName?: string | null;
}

interface ModelInfo {
    fullName: string;
    appName: string;
    name: string;
    filePath: string;
    line: number;
    fields: ModelField[];
}

let modelCache: Record<string, ModelInfo> = {};
const output = vscode.window.createOutputChannel('Django Model Navigator');
const builtInDjangoModels = [
    'User', 'Group', 'Permission', 'ContentType', 'Session', 'Site', 'AbstractUser', 'AbstractBaseUser'
];

export function activate(context: vscode.ExtensionContext) {
    output.show(true);
    output.appendLine('🔄 Django Model Navigator is activated...');

    const updateModelCache = async () => {
        try {
            modelCache = await scanWorkspaceForModels();
        } catch (e) {
            output.appendLine(`❌ Error updating the cache: ${e}`);
        }
    };

    updateModelCache();

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc.languageId === 'python') {
                updateModelCache();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('djangoModelNavigator.updateCache', () => {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Updating the model cache...',
                cancellable: false
            }, async () => {
                await updateModelCache();
            });
        })
    );

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider('python', {
            async provideDefinition(document, position, token) {
                const wordRange = document.getWordRangeAtPosition(position);
                if (!wordRange) return;

                const word = document.getText(wordRange).replace(/_set$/, '');
                const positionBefore = new vscode.Position(position.line, Math.max(0, wordRange.start.character - 1));
                const charBefore = document.getText(new vscode.Range(positionBefore, wordRange.start));

                if (charBefore !== '.' && !isKnownModel(word)) return;

                const locations = findAllTargets(word);
                if (locations.length === 0) return;
                if (locations.length === 1) return locations[0];

                const selected = await vscode.window.showQuickPick(
                    locations.map(loc => ({
                        label: path.basename(loc.uri.fsPath),
                        description: `${loc.uri.fsPath}:${loc.range.start.line + 1}`,
                        location: loc
                    })),
                    {
                        placeHolder: 'Select a definition'
                    }
                );

                return selected?.location;
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerHoverProvider('python', {
            provideHover(document, position, token) {
                const wordRange = document.getWordRangeAtPosition(position);
                if (!wordRange) return null;

                // Определяем всю цепочку (например, employee.profile.google_email)
                const lineText = document.lineAt(position.line).text;
                const cursorChar = position.character;

                // Найдём границы слова и точки слева/справа, чтобы получить цепочку
                // Пример: "employee.profile.google_email"
                // Мы ищем левый индекс начала цепочки и правый индекс конца цепочки
                let start = cursorChar;
                while (start > 0 && /[\w_\.]/.test(lineText[start - 1])) start--;
                let end = cursorChar;
                while (end < lineText.length && /[\w_]/.test(lineText[end])) end++;

                const fullChainStr = lineText.slice(start, end);
                const chain = fullChainStr.split('.');

                if (chain.length === 0) return null;

                const word = document.getText(wordRange).replace(/_set$/, '');
                // Если цепочка из одного слова — проверим, модель ли это или переменная с моделью, либо это модель
                if (chain.length === 1 || isKnownModel(word)) {
                    const variableModel = findVariableModel(document, word);
                    const modelName = variableModel || (isKnownModel(word) ? word : null);
                    if (modelName) {
                        let model = Object.values(modelCache).find(m => m.name.toLowerCase() === modelName.toLowerCase());
                        if (!model) return null;

                        const fieldsCode = model.fields
                            .map(field => {
                                let fieldDef = `    ${field.name} = models.${field.type}()`;
                                if (field.relatedModel) {
                                    fieldDef = `    ${field.name} = models.${field.type}('${field.relatedModel}')`;
                                }
                                return fieldDef;
                            })
                            .join('\n');

                        const md = new vscode.MarkdownString();
                        md.appendMarkdown(`**Модель**: \`${model.fullName}\`\n\n\`\`\`python\nclass ${model.name}(models.Model):\n${fieldsCode}\n\`\`\``);
                        return new vscode.Hover(md);
                    }
                } else {
                    // Цепочка из нескольких частей (employee.profile.google_email)
                    // Разрешаем модель для цепочки без последнего элемента (это поле)
                    const modelPart = chain.slice(0, -1);
                    let model = resolveChainModel(document, modelPart, word);

                    if (!model) return null;

                    // Ищем поле
                    const fieldName = chain[chain.length - 1];
                    const field = model.fields.find(f => f.name === fieldName);
                    if (!field) return null;

                    // Формируем hover для поля
                    const md = new vscode.MarkdownString();
                    md.appendMarkdown([
                        `**Тип**: \`models.${field.type}\``,
                        field.relatedModel ? `**Связанная модель**: \`${field.relatedModel}\`` : '',
                        field.relatedName ? `**related_name**: \`${field.relatedName}\`` : '',
                    ].filter(Boolean).join('\n'));

                    return new vscode.Hover(md);
                }

                return null;
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider('python', {
            provideCompletionItems(document, position, token, context) {
                const lineText = document.lineAt(position).text;
                const prefix = lineText.slice(0, position.character);
                const dotOnEnd = prefix.lastIndexOf('.') !== -1;

                // Проверяем, есть ли точка перед курсором
                const dotIndices = [];
                for (let i = 0; i < prefix.length; i++) {
                    if (prefix[i] === '.' && i > 0) {
                        dotIndices.push(i);
                    }
                }

                if (dotIndices.length === 0) return [];

                // Берём последнюю точку
                const lastDotIndex = dotIndices[dotIndices.length - 1];
                let start = lastDotIndex - 1;

                // Двигаемся назад, пока символ подходит для имени (буквы, цифры, _)
                while (start >= 0) {
                    const c = prefix[start];
                    if (/[a-zA-Z0-9_$]/.test(c)) {
                        start--;
                    } else if (c === ')' || c === ']') {
                        let depth = 1;
                        start--;
                        while (start >= 0 && depth > 0) {
                            const ch = prefix[start];
                            if (ch === ')') depth++;
                            else if (ch === '(') depth--;
                            start--;
                        }
                    } else {
                        break;
                    }
                }

                // Теперь у нас есть диапазон от start+1 до точки
                const chainStr = prefix.slice(start + 1, lastDotIndex);
                // Парсим цепочку
                let chain = chainStr.split('.').map(s => s.trim()).filter(Boolean);

                // Если в конце набирается текст, то удаляем его
                if (!dotOnEnd) chain = chain.slice(0, -1);

                // Если цепочка не найдена — выходим
                if (chain.length === 0) return [];

                // Разрешаем модель по цепочке
                const resolvedModel = resolveChainModel(document, chain, '');
                if (!resolvedModel) return [];

                // Фильтруем поля по префиксу
                const fieldPrefix = prefix.slice(lastDotIndex + 1).trim();
                return resolvedModel.fields
                    .filter(f => f.name.startsWith(fieldPrefix.toLowerCase()))
                    .map(field => {
                        const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field);
                        item.detail = `models.${field.type}`;
                        item.documentation = new vscode.MarkdownString([
                            `**Тип**: \`models.${field.type}\``,
                            field.relatedModel ? `**Связанная модель**: \`${field.relatedModel}\`` : '',
                            field.relatedName ? `**related_name**: \`${field.relatedName}\`` : '',
                        ].join('\n'));
                        return item;
                    });
            }
        }, '.' /* triggerCharacter */)
    );
}

// Поиск модели переменной в текущем файле
function findVariableModel(document: vscode.TextDocument, variableName: string): string | null {
    const text = document.getText();
    const variableModelPattern = /(\w+)\s*=\s*\(?\s*(\w+)\s*\.objects\b[\s\S]*?\)/g;

    const matches: Array<{ variable: string, model: string, index: number }> = [];
    let match;

    while ((match = variableModelPattern.exec(text)) !== null) {
        const [_, variable, model] = match;
        if (variable === variableName) {
            matches.push({variable, model, index: match.index});
        }
    }
    if (matches.length === 0) return null;

    matches.sort((a, b) => b.index - a.index);
    return matches[0].model;
}

// Разрешение цепочки вида employee.profile.google_email
function resolveChainModel(document: vscode.TextDocument, chain: string[], word: string): ModelInfo | undefined | null {
    if (chain.length === 0) return null;

    const models = Object.values(modelCache);

    // Если цепочка из одного элемента — ищем сразу
    if (chain.length === 1) {
        return models.find(m => m.name.toLowerCase() === chain[0].toLowerCase()) || null;
    }

    // Ищем модель по последнему элементу цепочки
    const modelName = chain.at(-1);
    const currentModel = models.find(m => m.name.toLowerCase() === modelName?.toLowerCase());
    if (!currentModel) return null;

    // Для автокомплита
    if (word === '') return currentModel;

    // Если есть поле с нужным именем — возвращаем модель
    const hasField = currentModel.fields.some(f => f.name === word);
    return hasField ? currentModel : null;
}

// Проверяет модель
function isKnownModel(name: string): boolean {
    return Object.values(modelCache).some(m => m.name.toLowerCase() === name) || builtInDjangoModels.includes(name);
}

function findAllTargets(word: string): vscode.Location[] {
    const candidates: vscode.Location[] = [];
    for (const model of Object.values(modelCache)) {
        const cleanWord = word.replace(/_set$/, '');

        if (model.name.toLowerCase() === cleanWord) {
            candidates.push(
                new vscode.Location(
                    vscode.Uri.file(model.filePath),
                    new vscode.Position(model.line, 0)
                )
            );
        }

        for (const field of model.fields) {
            if (field.name === cleanWord) {
                const fileContent = fs.readFileSync(model.filePath, 'utf-8');
                const lines = fileContent.split('\n');

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const match = line.trim().match(/^\s*(\w+)\s*=\s*models\.\w+\(/);
                    if (match && match[1] === field.name) {
                        candidates.push(
                            new vscode.Location(
                                vscode.Uri.file(model.filePath),
                                new vscode.Position(i, 0)
                            )
                        );
                    }
                }
            }
        }
    }

    return candidates;
}

async function scanWorkspaceForModels(): Promise<Record<string, ModelInfo>> {
    const modelsRaw: Record<string, {
        fullName: string;
        appName: string;
        name: string;
        filePath: string;
        line: number;
        fields: ModelField[];
        bases: string[];
    }> = {};

    const excludePattern = '{**/__pycache__/**,**/migrations/**,**/.git/**,**/node_modules/**}';
    const defaultPattern = '**/models.py';

    const additionalPatterns: string[] = vscode.workspace
        .getConfiguration('djangoModelNavigator')
        .get('additionalModelPaths', []);

    const allPatterns = [defaultPattern, ...additionalPatterns];

    const filesSet = new Set<string>();

    for (const pattern of allPatterns) {
        const uris = await vscode.workspace.findFiles(pattern, excludePattern);
        uris.forEach(uri => filesSet.add(uri.fsPath));
    }

    const files = [...filesSet];
    output.appendLine(`🔍 Scanning model files: ${files.length} найдено`);

    for (const file of files) {
        const filePath = file;
        const folderName = path.basename(path.dirname(filePath));
        let content: string;

        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch (e) {
            output.appendLine(`⚠️ Couldn't read the file: ${filePath}`);
            continue;
        }

        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const classMatch = line.match(/^class\s+(\w+)\(([^)]*)\)/);
            if (!classMatch) continue;

            const [, className, baseList] = classMatch;
            const bases = baseList.split(',').map(b => b.trim());

            const isModel = bases.some(base =>
                base === 'models.Model' ||
                base.startsWith('models.') ||
                builtInDjangoModels.includes(base)
            );
            if (!isModel) continue;

            const fullName = `${folderName}.models.${className}`;
            const fields: ModelField[] = [];

            for (let j = i + 1; j < lines.length; j++) {
                const l = lines[j];
                if (!l.trim() || l.startsWith('#')) continue;
                if (l.startsWith('class ')) break;

                const fieldMatch = l.match(/(\w+)\s*=\s*models\.(\w+)\(([^)]*)\)/);
                if (fieldMatch) {
                    const [_, fname, ftype, args] = fieldMatch;
                    let relatedModel;
                    let relatedName: string | null | undefined = undefined;

                    if (["ForeignKey", "OneToOneField", "ManyToManyField"].includes(ftype)) {
                        const modelMatch = args.match(/['"](\w+)['"]/);
                        if (modelMatch) relatedModel = modelMatch[1];

                        const relatedNameMatch = args.match(/related_name\s*=\s*['"]([\w_]+)['"]/);
                        if (relatedNameMatch) {
                            relatedName = relatedNameMatch[1];
                        } else if (/related_name\s*=\s*None/.test(args)) {
                            relatedName = null;
                        }
                    }

                    fields.push({name: fname, type: ftype, relatedModel, relatedName});
                }
            }

            modelsRaw[fullName] = {
                fullName,
                appName: folderName,
                name: className,
                filePath,
                line: i,
                fields,
                bases
            };
        }
    }

    // Построим финальную карту моделей с унаследованными полями
    const modelsFinal: Record<string, ModelInfo> = {};
    const getModelByName = (name: string) => Object.values(modelsRaw).find(m => m.name === name || m.fullName.endsWith(`.${name}`));
    const resolveFields = (model: typeof modelsRaw[string], visited = new Set<string>()): ModelField[] => {
        if (visited.has(model.fullName)) return [];
        visited.add(model.fullName);

        let fields = [...model.fields];

        for (const base of model.bases) {
            const baseName = base.replace(/^models\./, '');
            const parentModel = getModelByName(baseName);
            if (parentModel) {
                fields = [...resolveFields(parentModel, visited), ...fields];
            }
        }

        return fields;
    };

    for (const [fullName, model] of Object.entries(modelsRaw)) {
        const allFields = resolveFields(model);
        modelsFinal[fullName] = {
            fullName,
            appName: model.appName,
            name: model.name,
            filePath: model.filePath,
            line: model.line,
            fields: allFields
        };
    }

    // Обратные связи: ищем все модели, которые ссылаются на эту
    const setReverseRelatedModels = function (model: ModelInfo, modelsFinal: Record<string, ModelInfo>) {
        Object.values(modelsFinal).forEach(otherModel => {
            if (model.fullName === otherModel.fullName) return;

            otherModel.fields.forEach(field => {
                if (["ForeignKey", "OneToOneField", "ManyToManyField"].includes(field.type)) {
                    if (field.name === model.name.toLowerCase()) {
                        model.fields.push({name: otherModel.name.toLowerCase(), type: field.type});
                    }
                }
            });
        });
    }

    for (const [fullName, model] of Object.entries(modelsFinal)) {
        setReverseRelatedModels(model, modelsFinal);
    }

    output.appendLine(`✅ Total models found: ${Object.keys(modelsFinal).length}`);
    return modelsFinal;
}
