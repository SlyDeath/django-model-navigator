from django.db import models

from shop.models import Client as ShopClient, Tag as ShopTag
from shop.models import (
    Review,
)


class Tag(models.Model):
    """A local Tag model, distinct from shop.Tag."""

    title = models.CharField(max_length=50)


class Post(models.Model):
    # Unaliased Tag refers to the declaration in this file
    tag = models.ForeignKey(Tag, on_delete=models.CASCADE, related_name="posts_by_tag")

    # The imported alias identifies a model in another app
    client = models.ForeignKey(ShopClient, on_delete=models.CASCADE, related_name="posts")
    shop_tag = models.ManyToManyField(ShopTag, related_name="posts")
    review = models.ForeignKey(Review, on_delete=models.CASCADE, related_name="posts")
