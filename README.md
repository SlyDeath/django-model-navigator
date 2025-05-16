# Django Model Navigator

## 📌 Описание (Русский)

**Django Model Navigator** — это расширение для Visual Studio Code, которое обеспечивает интеллектуальную навигацию по Django-моделям: быстрый переход к определениям, всплывающие подсказки и автокомплит по полям моделей, включая связанные модели.

## Возможности

- Навигация по Ctrl+Click к определениям моделей и полей.
- Всплывающие подсказки с типами и связями моделей.
- Автокомплит по полям моделей и их цепочкам (например: `employee.profile.email`).
- Автоматическое обновление кэша при сохранении Python-файлов.
- Поддержка моделей с наследованием и `AbstractBaseUser`.
- Быстрый выбор модели при множественных совпадениях (QuickPick).
- Команда ручного обновления кэша через палитру команд.
- Работа с `apps.get_model()` и `from ... import`.

## Использование

Расширение начинает работать автоматически:

- Наведи курсор на атрибут модели — появится всплывающая подсказка с информацией о поле.
- Нажми `Ctrl+Click` (или `Cmd+Click` на macOS) по имени модели или полю для перехода к определению.
- Используй автокомплит при вводе `model.field.` для просмотра доступных полей следующей модели.

## Команды

Открыть через палитру команд (Ctrl+Shift+P / Cmd+Shift+P):

- `Django Model Navigator: Refresh Model Cache` — вручную обновить кэш моделей.

## Пример

```python
# models.py
class Profile(models.Model):
    email = models.EmailField()

class Employee(models.Model):
    profile = models.OneToOneField(Profile, on_delete=models.CASCADE)
```

В коде:
```python
employee.profile.email
# Наведи курсор на `email` или нажми Ctrl+Click — перейдёшь к определению в Profile.
```

## Требования

- Установлен Python и Django.
- Django-проект должен быть открыт целиком (корневая директория).


## 📌 Description (English)

**Django Model Navigator** is an extension for Visual Studio Code that provides intelligent navigation through Django models: quick access to definitions, tooltips, and autocomplete across model fields, including related models.

## Features

- Ctrl+Click navigation to model and field definitions.
- Tooltips with types and relationships of models.
- Autocomplete by model fields and their chains (for example: `employee.profile.email`).
- Automatic cache update when saving Python files.
- Support for models with inheritance and `AbstractBaseUser`.
- Quick model selection with multiple matches (QuickPick).
- The command to manually update the cache through the command palette.
- Working with `apps.get_model()` and `from ... import`.

## Usage

The extension starts working automatically:

- Hover over the model attribute to see a tooltip with information about the field.
- Press `Ctrl+Click` (or `Cmd+Click` on macOS) on the model name or field to go to the definition.
- Use the autocomplete when entering `model.field.` to view the available fields of the following model.

## Commands

Open via the command palette (Ctrl+Shift+P / Cmd+Shift+P):

- `Django Model Navigator: Refresh Model Cache` — manually update the model cache.

## Example

```python
# models.py
class Profile(models.Model):
    email = models.EmailField()

class Employee(models.Model):
    profile = models.OneToOneField(Profile, on_delete=models.CASCADE)
```

In the code:
```python
employee.profile.email
# Hover over `email` or press Ctrl+Click to go to the definition in Profile.
```

## Requirements

- Python and Django are installed.
- The Django project must be open in its entirety (root directory).
