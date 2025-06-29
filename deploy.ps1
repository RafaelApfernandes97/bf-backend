# Script de deploy para o backend
Write-Host "🚀 Iniciando deploy do backend..." -ForegroundColor Green

# Configurações
$IMAGE_NAME = "backend-fotos"
$TAG = "latest"
$REGISTRY = "your-registry.com"  # Substitua pelo seu registry

# Build da imagem
Write-Host "📦 Fazendo build da imagem..." -ForegroundColor Yellow
docker build -t $IMAGE_NAME`:$TAG .

# Tag para o registry
Write-Host "🏷️  Tagging imagem..." -ForegroundColor Yellow
docker tag $IMAGE_NAME`:$TAG $REGISTRY/$IMAGE_NAME`:$TAG

# Push para o registry
Write-Host "⬆️  Fazendo push para o registry..." -ForegroundColor Yellow
docker push $REGISTRY/$IMAGE_NAME`:$TAG

Write-Host "✅ Deploy do backend concluído!" -ForegroundColor Green
Write-Host "📋 Imagem: $REGISTRY/$IMAGE_NAME`:$TAG" -ForegroundColor Cyan 