from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    phone = models.CharField(max_length=20)


class Profile(models.Model):
    email = models.EmailField()
    user = models.OneToOneField(User, on_delete=models.CASCADE)


class LegacyProfile(Profile):
    class Meta:
        proxy = True
