from django.conf import settings
from django.db import models
from django.db.models import CharField


class TimeStampedModel(models.Model):
    """Abstract base with shared fields.

    Parentheses ( and ) inside this docstring must not affect parsing.
    """

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Status(models.TextChoices):
    NEW = "new", "Новый"
    DONE = "done", "Готов"


class ClientQuerySet(models.QuerySet):
    def active(self):
        name = models.CharField(max_length=10)  # A method-local assignment, not a model field
        return self.filter(is_active=True)


class Client(TimeStampedModel):
    objects = ClientQuerySet.as_manager()

    name = CharField(max_length=255)  # A field constructor imported without the models prefix
    note = models.TextField(help_text="Текст со скобкой ( и символом #")
    parent = models.ForeignKey("self", on_delete=models.CASCADE, related_name="children")
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="clients",
    )
    manager = models.ForeignKey(to="accounts.User", on_delete=models.PROTECT, related_name="+")

    class Meta:
        ordering = ("name",)

    def display(self):
        title = models.CharField(max_length=5)
        return self.name


class Review(TimeStampedModel):
    client = models.ForeignKey(Client, on_delete=models.CASCADE)
    profile = models.OneToOneField("accounts.Profile", on_delete=models.CASCADE)
    tags = models.ManyToManyField("shop.Tag", related_name="%(class)s_items")
    text = models.TextField()


class Tag(models.Model):
    slug = models.SlugField()


class Worker(TimeStampedModel):
    """The model name deliberately differs from the variables used in tests."""

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="employees")
    profile = models.OneToOneField("accounts.Profile", on_delete=models.CASCADE)
    rate = models.DecimalField(max_digits=8, decimal_places=2)
