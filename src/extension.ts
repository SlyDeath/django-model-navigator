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

                const chain = getChain(document, position);

                let model;
                if (chain) {
                    let modelPart = chain;
                    if (chain.length > 1) modelPart = modelPart.slice(0, -1);
                    model = resolveChainModel(document, modelPart, word);
                }

                const locations = findAllTargets(word, model ?? null);
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

                const chain = getChain(document, position);
                if (!chain) return null;

                const word = document.getText(wordRange).replace(/_set$/, '');
                // Если цепочка из одного слова — проверим, модель ли это или переменная с моделью, либо это модель
                if (chain.length === 1 || isKnownModel(word)) {
                    return getModelMD(document, word);
                }

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

                if (field.relatedModel && isKnownModel(field.relatedModel)) {
                    return getModelMD(document, field.relatedModel);
                } else {
                    md.appendMarkdown(`**Тип**: \`models.${field.type}\``);
                    return new vscode.Hover(md);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider('python', {
            provideCompletionItems(document, position, token, context) {
                const lineText = document.lineAt(position).text;
                const prefix = lineText.slice(0, position.character);

                // Проверяем, есть ли точка перед курсором
                const dotIndices = [];
                for (let i = 0; i < prefix.length; i++) {
                    if (prefix[i] === '.' && i > 0) dotIndices.push(i);
                }

                if (dotIndices.length === 0) return [];

                // Берём последнюю точку
                const lastDotIndex = dotIndices[dotIndices.length - 1];

                let chain = getChain(document, position);
                if (!chain) return null;

                let chainStr = chain.join('.');
                const dotOnEnd = chainStr.lastIndexOf('.') !== -1;

                // Если в конце набирается текст, то удаляем его
                if (!chainStr) chainStr = chainStr.slice(0, -1);
                const modelPart = chain.slice(0, -1);
                // Разрешаем модель по цепочке
                const resolvedModel = resolveChainModel(document, modelPart, '');
                if (!resolvedModel) return [];

                // Фильтруем поля по префиксу
                const fieldPrefix = prefix.slice(lastDotIndex + 1).trim();
                return resolvedModel.fields
                    .filter(f => f.name.startsWith(fieldPrefix.toLowerCase()))
                    .map(field => {
                        const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field);
                        item.detail = `${field.type}()`;
                        //item.documentation = new vscode.MarkdownString(`**Тип**: \`${field.type}()\``);
                        if (field.relatedModel) {
                            item.detail = `${field.type}('${field.relatedModel}')`;
                            //item.documentation = new vscode.MarkdownString(`**Тип**: \`${field.type}('${field.relatedModel}')\``);
                        }
                        return item;
                    });
            }
        }, '.' /* triggerCharacter */)
    );
}

function getChain(document: vscode.TextDocument, position: vscode.Position) {
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

    return chain;
}

function getModelMD(document: vscode.TextDocument, name: string) {
    const variableModel = findVariableModel(document, name);
    const modelName = variableModel || (isKnownModel(name) ? name : null);
    if (modelName) {
        let model = Object.values(modelCache).find(m => m.name.toLowerCase() === modelName.toLowerCase());
        if (!model) return null;

        const fieldsCode = model.fields
            .map(field => {
                let fieldDef = `    ${field.name} = ${field.type}()`;
                if (field.relatedModel) {
                    fieldDef = `    ${field.name} = ${field.type}('${field.relatedModel}')`;
                }
                return fieldDef;
            })
            .join('\n');

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**Модель**: \`${model.fullName}\`\n\n\`\`\`python\nclass ${model.name}(models.Model):\n${fieldsCode}\n\`\`\``);
        return new vscode.Hover(md);
    }
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
            matches.push({ variable, model, index: match.index });
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

    const lastWord = chain.at(-1);

    // Если не нашёл по первому модель, то найти её через родителя
    let currentModel = null;
    for (let i = chain.length - 1; i >= 0; i--) {
        const modelName = chain[i];
        currentModel = models.find(m => m.name.toLowerCase() === modelName.toLowerCase());
        if (currentModel) break;
    }
    if (!currentModel) return null;

    // Если есть поле с нужным именем — возвращаем модель
    let hasField = currentModel.fields.some(f => f.name === word || f.name === lastWord);
    if (hasField && word) return currentModel;

    // Для автокомплита, если имя поля отличается от имени модели
    if (hasField && !word) {
        const chainedModel = currentModel.fields.find(
            el => el.name === lastWord && el.relatedModel
        )?.relatedModel;

        if (chainedModel) {
            return models.find(m => m.name.toLowerCase() === chainedModel);
        }

        return null;
    }

    // Для автокомплита
    if (!word) return currentModel;

    return hasField ? currentModel : null;
}

// Проверяет модель
function isKnownModel(name: string): boolean {
    return Object.values(modelCache).some(m => m.name.toLowerCase() === name.toLowerCase()) || builtInDjangoModels.includes(name);
}

function findAllTargets(word: string, wordModel: ModelInfo | null): vscode.Location[] {
    const modelsCandidates: vscode.Location[] = [];
    const fieldsCandidates: vscode.Location[] = [];

    for (const model of Object.values(modelCache)) {
        const cleanWord = word.toLowerCase().replace(/_set$/, '');

        if (model.name.toLowerCase() === cleanWord) {
            modelsCandidates.push(
                new vscode.Location(
                    vscode.Uri.file(model.filePath),
                    new vscode.Position(model.line, 0)
                )
            );
        }

        if (wordModel) {
            const fileContent = fs.readFileSync(wordModel.filePath, 'utf-8');
            const lines = fileContent.split('\n');

            for (let i = 0; i < lines.length; i++) {
                if (fieldsCandidates.length) break;

                const line = lines[i].trim();
                const classMatch = line.match(/^class\s+(\w+)\(([^)]*)\)/);
                if (!classMatch) continue;

                const [, className, baseList] = classMatch;
                const bases = baseList.split(',').map(b => b.trim());

                const isModel = bases.some(base =>
                    !(
                        base.startsWith('models.TextChoices') ||
                        base.startsWith('models.IntegerChoices')
                    )
                    &&
                    (
                        base === 'models.Model' ||
                        base.startsWith('models.') ||
                        builtInDjangoModels.includes(base)
                    )
                );

                if (!isModel) continue;
                if (wordModel.name !== className) continue;

                for (let j = i + 1; j < lines.length; j++) {
                    const l = lines[j];
                    if (!l.trim() || l.startsWith('#')) continue;
                    if (l.startsWith('class ')) break;

                    const fieldMatch = l.match(/(\w+)\s*=\s*models\.(\w+)\(([^)]*)\)/);
                    if (fieldMatch && (fieldMatch[1] === word)) {
                        fieldsCandidates.push(
                            new vscode.Location(
                                vscode.Uri.file(wordModel.filePath),
                                new vscode.Position(j, 0)
                            )
                        );
                        break;
                    }
                }
            }
        } else {
            for (const field of model.fields) {
                if (field.name === cleanWord) {
                    const fileContent = fs.readFileSync(model.filePath, 'utf-8');
                    const lines = fileContent.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const match = line.trim().match(/^\s*(\w+)\s*=\s*models\.\w+\(/);
                        if (match && (match[1] === field.name)) {
                            fieldsCandidates.push(
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
    }

    return [...modelsCandidates, ...fieldsCandidates];
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
                !(
                    base.startsWith('models.TextChoices') ||
                    base.startsWith('models.IntegerChoices')
                )
                &&
                (
                    base === 'models.Model' ||
                    base.startsWith('models.') ||
                    builtInDjangoModels.includes(base)
                )
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
                    let relatedModel: string | null | undefined = undefined,
                        relatedName: string | null | undefined = undefined;

                    if (["ForeignKey", "OneToOneField", "ManyToManyField"].includes(ftype)) {
                        const modelMatch = args.match(/^(\w+),/);
                        if (modelMatch) relatedModel = modelMatch[1].toLowerCase();

                        const relatedNameMatch = args.match(/related_name\s*=\s*['"]([\w_]+)['"]/);
                        if (relatedNameMatch) {
                            relatedName = relatedNameMatch[1];
                        } else if (/related_name\s*=\s*None/.test(args)) {
                            relatedName = null;
                        }
                    }

                    fields.push({ name: fname, type: ftype, relatedModel, relatedName });
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
                        model.fields.push({ name: otherModel.name.toLowerCase(), type: field.type });
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
