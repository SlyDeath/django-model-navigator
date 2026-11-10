from shop.models import Client


def filter_query(query, domain):
    if domain:
        return query.filter(name__icontains=domain)
    return query.exclude(name="")


def get_clients_query(request):
    domain = request.GET.get("domain", "All")
    query = (
        Client.objects.distinct()
        .filter(name=domain)
        .select_related("owner")
    )
    if domain:
        query = query.filter(name__icontains=domain)
    query = filter_query(query, domain)
    query = query.order_by("name")
    query = query.all()
    query = query.filter(id__gt=0)
    query = query.exclude(id__lt=0)
    query = query.select_related("owner")
    query = query.prefetch_related("employees")
    query = query.filter(name__isnull=False)
    query = query.distinct()
    query = query.all()
    return (
        domain,
        "city",
        "client",
        "services",
        "positioning",
        "site_type",
        "template",
        "status",
        "adv_stage",
        "problematic",
        "tech",
        "production_stage",
        "chargeable",
        query,
    )
